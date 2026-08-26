/**
 * Every search's full, pre-cascade candidate round, backed by D1.
 *
 * Kept apart from `search_relevance` even though both are search telemetry:
 * that table holds what a caller was shown and later judged; this one holds
 * what every method actually found before quotas cut it down — the round
 * that answers "did the code find the real match and just not surface it",
 * not "was what it surfaced any good".
 *
 * Structurally the same as the other sinks: lazy table creation, so a fresh
 * database needs no setup ritual.
 */

import type { RawSearchRound, RawSearchSink } from "../search_memory";

/** Table holding one row per candidate in a search's full round. */
export const RAW_SEARCH_TABLE = "raw_search_rounds";

/**
 * Statement creating the table if absent.
 *
 * One row per candidate rather than one row per search with a JSON blob of
 * candidates, matching `search_relevance`'s own reasoning: queryable and
 * aggregable in SQL without parsing every row. `round_id` groups the rows
 * that came from the same search, since two rows sharing a query and
 * timestamp are not guaranteed unique on their own.
 */
const CREATE_TABLE_STATEMENT =
  `CREATE TABLE IF NOT EXISTS ${RAW_SEARCH_TABLE} (` +
  "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
  "  round_id TEXT NOT NULL," +
  "  timestamp TEXT NOT NULL," +
  "  query TEXT NOT NULL," +
  "  chunks_searched INTEGER NOT NULL," +
  "  method TEXT NOT NULL," +
  "  path TEXT NOT NULL," +
  "  ordinal INTEGER NOT NULL," +
  "  exact REAL," +
  "  starts_with REAL," +
  "  ends_with REAL," +
  "  contains REAL," +
  "  contained_by REAL," +
  "  fuzzy_score REAL," +
  "  cosine_similarity REAL," +
  "  best_method TEXT," +
  "  best_score REAL" +
  ")";

const INSERT_LEXICAL_STATEMENT =
  `INSERT INTO ${RAW_SEARCH_TABLE} ` +
  "(round_id, timestamp, query, chunks_searched, method, path, ordinal, " +
  "exact, starts_with, ends_with, contains, contained_by, fuzzy_score, " +
  "best_method, best_score) " +
  "VALUES (?, ?, ?, ?, 'lexical', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

const INSERT_SEMANTIC_STATEMENT =
  `INSERT INTO ${RAW_SEARCH_TABLE} ` +
  "(round_id, timestamp, query, chunks_searched, method, path, ordinal, " +
  "cosine_similarity) " +
  "VALUES (?, ?, ?, ?, 'semantic', ?, ?, ?)";

/**
 * Build a sink that writes every search's full round to D1.
 *
 * @param database - The bound D1 database.
 * @param options.now - Clock, injected so the timestamp is testable.
 * @param options.roundId - Generates the id grouping one round's rows.
 *   Injected for the same reason as the clock.
 * @returns A sink suitable for the memory server's `rawSearchSink`.
 */
export function d1RawSearchSink(
  database: D1Database,
  options: { now: () => number; roundId: () => string },
): RawSearchSink {
  return async (round: RawSearchRound) => {
    if (round.lexical.length === 0 && round.semantic.length === 0) {
      return;
    }

    const roundId = options.roundId();
    const timestamp = new Date(options.now()).toISOString();

    const statements = [
      database.prepare(CREATE_TABLE_STATEMENT),
      ...round.lexical.map((hit) =>
        database
          .prepare(INSERT_LEXICAL_STATEMENT)
          .bind(
            roundId,
            timestamp,
            round.query,
            round.chunksSearched,
            hit.chunk.path,
            hit.chunk.ordinal,
            hit.scores.exact,
            hit.scores.starts_with,
            hit.scores.ends_with,
            hit.scores.contains,
            hit.scores.contained_by,
            hit.scores.fuzzy,
            hit.bestMethod,
            hit.bestScore,
          ),
      ),
      ...round.semantic.map((hit) =>
        database
          .prepare(INSERT_SEMANTIC_STATEMENT)
          .bind(
            roundId,
            timestamp,
            round.query,
            round.chunksSearched,
            hit.chunk.path,
            hit.chunk.ordinal,
            hit.similarity,
          ),
      ),
    ];

    await database.batch(statements);
  };
}
