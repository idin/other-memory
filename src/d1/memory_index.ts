/**
 * The memory index, backed by D1.
 *
 * Shared rather than per-session, because the index is a pure function of the
 * commit: whoever builds at a given commit builds it for everyone, and a
 * session arriving at an already-built commit does no work. The alternative —
 * Durable Object storage, which needs no binding — would re-embed the whole
 * store on every new connection to compute rows a previous session already
 * computed.
 */

import {
  packChunk,
  packVector,
  unpackChunkLists,
  unpackVector,
  type MemoryIndex,
  type MemoryIndexChunk,
  type MemoryIndexIdentity,
} from "../memory_index";

/** Table holding one row per chunk. */
export const CHUNK_TABLE = "search_chunks";

/** Table holding one row per index build. */
export const INDEX_STATE_TABLE = "memory_index_state";

/**
 * D1's cap on bound parameters in a single statement.
 *
 * Documented by Cloudflare as 100. `carryForward`'s exclusion list binds one
 * parameter per excluded path plus four fixed ones.
 */
const D1_MAX_BOUND_PARAMETERS = 100;

/**
 * How many excluded paths fit in one `carryForward` statement, after its
 * four fixed parameters (`to.commitSha`, `from.commitSha`, `from.model`,
 * `from.pooling`). Exposed via `MemoryIndex.maxCarryForwardExclusions`, so
 * `planRebuild` falls back to a full rebuild before ever calling
 * `carryForward` with more paths than this.
 */
export const MAX_CARRY_FORWARD_EXCLUSIONS = D1_MAX_BOUND_PARAMETERS - 4;

/**
 * Statements creating the tables if absent.
 *
 * Run before access rather than as a migration, matching `failure_sink.ts`
 * and for its reason: one cheap statement, and no setup ritual to remember on
 * the day someone is already debugging something else.
 *
 * The primary key is (commit_sha, model, pooling, path, ordinal). All three
 * identity columns are in the key because vectors from different models — or
 * from cls and mean pooling of one model — are not comparable, and comparing
 * across them returns a plausible number rather than an error.
 */
const CREATE_CHUNK_TABLE =
  `CREATE TABLE IF NOT EXISTS ${CHUNK_TABLE} (` +
  "  commit_sha TEXT NOT NULL," +
  "  model TEXT NOT NULL," +
  "  pooling TEXT NOT NULL," +
  "  path TEXT NOT NULL," +
  "  ordinal INTEGER NOT NULL," +
  "  heading_path TEXT NOT NULL," +
  "  file_preamble TEXT NOT NULL," +
  "  text TEXT NOT NULL," +
  "  superseded TEXT NOT NULL," +
  "  contains_superseded INTEGER NOT NULL," +
  "  depends_on_previous INTEGER NOT NULL," +
  "  is_message INTEGER NOT NULL," +
  "  is_deep INTEGER NOT NULL," +
  "  start_line INTEGER NOT NULL," +
  "  end_line INTEGER NOT NULL," +
  "  vector BLOB," +
  "  PRIMARY KEY (commit_sha, model, pooling, path, ordinal)" +
  ")";

const CREATE_STATE_TABLE =
  `CREATE TABLE IF NOT EXISTS ${INDEX_STATE_TABLE} (` +
  "  model TEXT NOT NULL," +
  "  pooling TEXT NOT NULL," +
  "  commit_sha TEXT NOT NULL," +
  "  built_at TEXT NOT NULL," +
  "  PRIMARY KEY (model, pooling)" +
  ")";

type ChunkRow = {
  path: string;
  ordinal: number;
  heading_path: string;
  file_preamble: string;
  text: string;
  superseded: string;
  contains_superseded: number;
  depends_on_previous: number;
  is_message: number;
  is_deep: number;
  start_line: number;
  end_line: number;
  vector: ArrayBuffer | null;
};

/**
 * Build a memory index backed by D1.
 *
 * @param database - The bound D1 database.
 * @param now - Clock, injected so the built-at timestamp is testable.
 * @returns An index suitable for the memory server's `memoryIndex`.
 */
export function d1MemoryIndex(
  database: D1Database,
  options: { now: () => number },
): MemoryIndex {
  async function ensureTables(): Promise<void> {
    await database.batch([
      database.prepare(CREATE_CHUNK_TABLE),
      database.prepare(CREATE_STATE_TABLE),
    ]);
  }

  return {
    maxCarryForwardExclusions: MAX_CARRY_FORWARD_EXCLUSIONS,

    async load(identity: MemoryIndexIdentity): Promise<MemoryIndexChunk[]> {
      await ensureTables();
      const result = await database
        .prepare(
          "SELECT path, ordinal, heading_path, file_preamble, text, " +
            "superseded, contains_superseded, depends_on_previous, " +
            "is_message, is_deep, start_line, end_line, vector " +
            `FROM ${CHUNK_TABLE} ` +
            "WHERE commit_sha = ? AND model = ? AND pooling = ? " +
            "ORDER BY path, ordinal",
        )
        .bind(identity.commitSha, identity.model, identity.pooling)
        .all<ChunkRow>();

      return (result.results ?? []).map((row) => {
        const lists = unpackChunkLists({
          headingPath: row.heading_path,
          superseded: row.superseded,
        });
        return {
          chunk: {
            path: row.path,
            ordinal: row.ordinal,
            headingPath: lists.headingPath,
            filePreamble: row.file_preamble,
            text: row.text,
            superseded: lists.superseded,
            containsSuperseded: row.contains_superseded === 1,
            dependsOnPrevious: row.depends_on_previous === 1,
            isMessage: row.is_message === 1,
            isDeep: row.is_deep === 1,
            startLine: row.start_line,
            endLine: row.end_line,
          },
          vector: row.vector ? unpackVector(row.vector) : null,
        };
      });
    },

    async replaceFile(
      identity: MemoryIndexIdentity,
      path: string,
      chunks: MemoryIndexChunk[],
    ): Promise<void> {
      await ensureTables();
      // Delete then insert rather than update: an edit can change how many
      // chunks a file produces, so the old rows do not correspond to the new
      // ones and updating in place would leave orphans.
      const statements = [
        database
          .prepare(
            `DELETE FROM ${CHUNK_TABLE} ` +
              "WHERE commit_sha = ? AND model = ? AND pooling = ? AND path = ?",
          )
          .bind(identity.commitSha, identity.model, identity.pooling, path),
        ...chunks.map(({ chunk, vector }) => {
          const packed = packChunk(chunk);
          return database
            .prepare(
              `INSERT INTO ${CHUNK_TABLE} ` +
                "(commit_sha, model, pooling, path, ordinal, heading_path, " +
                "file_preamble, text, superseded, contains_superseded, " +
                "depends_on_previous, is_message, is_deep, start_line, " +
                "end_line, vector) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(
              identity.commitSha,
              identity.model,
              identity.pooling,
              chunk.path,
              chunk.ordinal,
              packed.headingPath,
              chunk.filePreamble,
              chunk.text,
              packed.superseded,
              chunk.containsSuperseded ? 1 : 0,
              chunk.dependsOnPrevious ? 1 : 0,
              chunk.isMessage ? 1 : 0,
              chunk.isDeep ? 1 : 0,
              chunk.startLine,
              chunk.endLine,
              vector ? packVector(vector) : null,
            );
        }),
      ];
      await database.batch(statements);
    },

    async removeFile(identity: MemoryIndexIdentity, path: string): Promise<void> {
      await ensureTables();
      await database
        .prepare(
          `DELETE FROM ${CHUNK_TABLE} ` +
            "WHERE commit_sha = ? AND model = ? AND pooling = ? AND path = ?",
        )
        .bind(identity.commitSha, identity.model, identity.pooling, path)
        .run();
    },

    async carryForward(options: {
      from: MemoryIndexIdentity;
      to: MemoryIndexIdentity;
      exceptPaths: string[];
    }): Promise<void> {
      await ensureTables();
      // One INSERT ... SELECT rather than a read followed by a write per
      // file. A Worker's outbound calls are capped per request, so copying
      // file by file would make editing one file in a large store cost nearly
      // as much as rebuilding everything.
      //
      // OR IGNORE rather than a conflict clause: a row already present at the
      // target commit was written by this build and is newer than what is
      // being copied, so the existing one wins.
      const placeholders = options.exceptPaths.map(() => "?").join(", ");
      const exclusion =
        options.exceptPaths.length > 0
          ? ` AND path NOT IN (${placeholders})`
          : "";
      await database
        .prepare(
          `INSERT OR IGNORE INTO ${CHUNK_TABLE} ` +
            "(commit_sha, model, pooling, path, ordinal, heading_path, " +
            "file_preamble, text, superseded, contains_superseded, " +
            "depends_on_previous, is_message, is_deep, start_line, " +
            "end_line, vector) " +
            "SELECT ?, model, pooling, path, ordinal, heading_path, " +
            "file_preamble, text, superseded, contains_superseded, " +
            "depends_on_previous, is_message, is_deep, start_line, " +
            "end_line, vector " +
            `FROM ${CHUNK_TABLE} ` +
            "WHERE commit_sha = ? AND model = ? AND pooling = ?" +
            exclusion,
        )
        .bind(
          options.to.commitSha,
          options.from.commitSha,
          options.from.model,
          options.from.pooling,
          ...options.exceptPaths,
        )
        .run();
    },

    async builtCommit(
      identity: Omit<MemoryIndexIdentity, "commitSha">,
    ): Promise<string | null> {
      try {
        const row = await database
          .prepare(
            `SELECT commit_sha FROM ${INDEX_STATE_TABLE} ` +
              "WHERE model = ? AND pooling = ?",
          )
          .bind(identity.model, identity.pooling)
          .first<{ commit_sha: string }>();
        return row?.commit_sha ?? null;
      } catch {
        // Created on first write, so "no such table" and "never built" are the
        // same state, and both mean a full build.
        return null;
      }
    },

    async recordBuiltCommit(identity: MemoryIndexIdentity): Promise<void> {
      await ensureTables();
      // Written last, after every chunk has landed. A crash before this point
      // leaves the previous sha, so the next run redoes work — recoverable.
      // The opposite order would claim a build that never finished, and every
      // later incremental update would compound the gap silently.
      await database
        .prepare(
          `INSERT INTO ${INDEX_STATE_TABLE} (model, pooling, commit_sha, built_at) ` +
            "VALUES (?, ?, ?, ?) " +
            "ON CONFLICT (model, pooling) DO UPDATE SET " +
            "commit_sha = excluded.commit_sha, built_at = excluded.built_at",
        )
        .bind(
          identity.model,
          identity.pooling,
          identity.commitSha,
          new Date(options.now()).toISOString(),
        )
        .run();
    },

    async discardOtherCommits(identity: MemoryIndexIdentity): Promise<void> {
      await ensureTables();
      // Runs after a build completes, so the table holds one commit's rows
      // rather than growing without bound. Deliberately not before: the old
      // rows are what a concurrent session is still reading from.
      await database
        .prepare(
          `DELETE FROM ${CHUNK_TABLE} ` +
            "WHERE model = ? AND pooling = ? AND commit_sha != ?",
        )
        .bind(identity.model, identity.pooling, identity.commitSha)
        .run();
    },
  };
}
