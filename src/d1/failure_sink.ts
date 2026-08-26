/**
 * Durable storage for tool failures, backed by D1.
 *
 * The base server defaults to writing failures to the console, which Workers
 * observability captures. That is enough to see what broke while it is still
 * breaking, but retention is finite and the console is awkward to ask
 * questions of. A failure noticed a fortnight later — or a pattern visible
 * only across many of them — needs rows.
 *
 * Opt-in: importing this file (via the `other-memory/d1` subpath) is the only
 * way it costs anything. The base server has no D1 dependency and works
 * without a database.
 */

import type { FailureSink, ToolFailure } from "../tool_errors";

/** Table holding one row per failed tool call. */
export const TOOL_FAILURE_TABLE = "tool_failures";

/**
 * Statement creating the failure table if it is absent.
 *
 * Run before each insert rather than as a migration step: it costs one
 * cheap statement, and it means a fresh database needs no setup ritual
 * that someone has to remember on the day they are already debugging
 * something else.
 */
const CREATE_TABLE_STATEMENT =
  `CREATE TABLE IF NOT EXISTS ${TOOL_FAILURE_TABLE} (` +
  "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
  "  timestamp TEXT NOT NULL," +
  "  tool TEXT NOT NULL," +
  "  login TEXT," +
  "  arguments TEXT NOT NULL," +
  "  message TEXT NOT NULL," +
  "  stack TEXT" +
  ")";

const INSERT_STATEMENT =
  `INSERT INTO ${TOOL_FAILURE_TABLE} ` +
  "(timestamp, tool, login, arguments, message, stack) VALUES (?, ?, ?, ?, ?, ?)";

/**
 * Build a sink that writes failures to D1.
 *
 * @param database - The bound D1 database.
 * @returns A sink suitable for the memory server's `failureSink`.
 */
export function d1FailureSink(database: D1Database): FailureSink {
  return async (failure: ToolFailure) => {
    await database.batch([
      database.prepare(CREATE_TABLE_STATEMENT),
      database
        .prepare(INSERT_STATEMENT)
        .bind(
          failure.timestamp,
          failure.tool,
          failure.login,
          failure.arguments,
          failure.message,
          failure.stack,
        ),
    ]);
  };
}

/**
 * Read the most recent failures, newest first.
 *
 * The reason the rows are kept: sitting down at a machine later and
 * asking what has been going wrong.
 *
 * @param database - The bound D1 database.
 * @param options.limit - How many rows to return.
 * @returns The stored failures, newest first. Empty when nothing has
 *   failed, including when nothing has ever failed and the table has yet
 *   to be created.
 */
export async function recentFailures(
  database: D1Database,
  options: { limit: number },
): Promise<ToolFailure[]> {
  try {
    const result = await database
      .prepare(
        `SELECT timestamp, tool, login, arguments, message, stack ` +
          `FROM ${TOOL_FAILURE_TABLE} ORDER BY id DESC LIMIT ?`,
      )
      .bind(options.limit)
      .all<ToolFailure>();
    return result.results ?? [];
  } catch {
    // The table is created on first write, so "no such table" and "no
    // failures yet" are the same state. Reporting an error for the
    // healthy case would be its own small lie.
    return [];
  }
}
