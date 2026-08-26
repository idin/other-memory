/**
 * Judgments about search results, backed by D1.
 *
 * Kept apart from the index tables even though both live in the same
 * database, because they have opposite lifetimes. Index rows are discarded
 * once their commit is superseded — they are a cache. These accumulate across
 * commits and models, and are worth nothing until there are enough of them.
 *
 * Structurally the same as the failure and usage sinks: lazy table creation,
 * for the same reason, so a fresh database needs no setup ritual.
 */

import type { CandidateRecord, RelevanceSink } from "../agent_assessments";

/** Table holding one row per judged or unjudged candidate. */
export const RELEVANCE_TABLE = "search_relevance";

/**
 * Statement creating the table if absent.
 *
 * `agent_assessment` is text rather than a boolean because there are three
 * states, and the third is the point. Storing it as a nullable boolean would
 * invite reading NULL as false somewhere downstream, which is exactly the
 * conflation the three states exist to prevent.
 *
 * The feature columns are stored individually rather than as one JSON blob so
 * that training data can be queried and aggregated in SQL without parsing
 * every row. A null in a rank or the cosine column means that method did not
 * see this candidate at all, which is a different fact from ranking last or
 * scoring zero — and conflating the two would teach a model that unseen means
 * unrelated.
 *
 * There is no single `rank` column: only fuzzy and cosine produce an
 * ordering, and averaging them into one number would destroy the
 * disagreement between methods that makes the data informative in the first
 * place.
 */
const CREATE_TABLE_STATEMENT =
  `CREATE TABLE IF NOT EXISTS ${RELEVANCE_TABLE} (` +
  "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
  "  timestamp TEXT NOT NULL," +
  "  login TEXT," +
  "  query TEXT NOT NULL," +
  "  path TEXT NOT NULL," +
  "  ordinal INTEGER NOT NULL," +
  "  chunk_length INTEGER NOT NULL," +
  "  exact REAL NOT NULL," +
  "  starts_with REAL NOT NULL," +
  "  ends_with REAL NOT NULL," +
  "  contains REAL NOT NULL," +
  "  contained_by REAL NOT NULL," +
  "  fuzzy_score REAL NOT NULL," +
  "  fuzzy_rank INTEGER," +
  "  cosine_similarity REAL," +
  "  cosine_similarity_rank INTEGER," +
  "  agent_assessment TEXT NOT NULL," +
  "  assessed_by TEXT" +
  ")";

const INSERT_STATEMENT =
  `INSERT INTO ${RELEVANCE_TABLE} ` +
  "(timestamp, login, query, path, ordinal, chunk_length, exact, " +
  "starts_with, ends_with, contains, contained_by, fuzzy_score, fuzzy_rank, " +
  "cosine_similarity, cosine_similarity_rank, agent_assessment, assessed_by) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/**
 * Build a sink that writes judgments to D1.
 *
 * @param database - The bound D1 database.
 * @returns A sink suitable for the memory server's `relevanceSink`.
 */
export function d1RelevanceSink(database: D1Database): RelevanceSink {
  return async (records: CandidateRecord[]) => {
    if (records.length === 0) {
      return;
    }
    await database.batch([
      database.prepare(CREATE_TABLE_STATEMENT),
      ...records.map((record) =>
        database
          .prepare(INSERT_STATEMENT)
          .bind(
            record.timestamp,
            record.login,
            record.query,
            record.path,
            record.ordinal,
            record.chunkLength,
            record.features.exact,
            record.features.startsWith,
            record.features.endsWith,
            record.features.contains,
            record.features.containedBy,
            record.features.fuzzy,
            record.fuzzyRank,
            record.features.cosine,
            record.cosineSimilarityRank,
            record.agentAssessment,
            record.assessedBy,
          ),
      ),
    ]);
  };
}

/**
 * Count what has been collected so far, by assessment.
 *
 * The question this answers is whether there is yet enough to train anything,
 * and in particular whether both classes are represented — a set of only
 * relevant examples cannot teach a model to tell them apart.
 *
 * @param database - The bound D1 database.
 * @returns One count per assessment. Empty when nothing has been recorded.
 */
export async function judgmentCounts(
  database: D1Database,
): Promise<{ label: string; count: number }[]> {
  try {
    const result = await database
      .prepare(
        `SELECT agent_assessment AS label, COUNT(*) AS count ` +
          `FROM ${RELEVANCE_TABLE} GROUP BY agent_assessment ORDER BY agent_assessment`,
      )
      .all<{ label: string; count: number }>();
    return result.results ?? [];
  } catch {
    // Created on first write, so "no such table" and "nothing judged yet" are
    // the same state.
    return [];
  }
}
