/**
 * Durable storage for API usage, backed by D1.
 *
 * The base server discards usage by default, because most deployments have
 * nowhere to put it and a search should not fail for want of a metering
 * table. Where there is a database, the questions worth answering — how
 * close is this to the free allowance, what caused that spike — need rows
 * rather than a log.
 *
 * Structurally identical to `failure_sink.ts`, deliberately: same lazy table
 * creation, same reason, same shape. Two sinks that behave differently for
 * no reason would be two things to remember instead of one.
 */

import type { ApiUsage, UsageSink } from "../api_usage";

/** Table holding one row per external API call. */
export const API_USAGE_TABLE = "api_usage";

/**
 * Statement creating the usage table if it is absent.
 *
 * Run before each insert rather than as a migration, for the same reason the
 * failure table is: one cheap statement, and no setup ritual to remember.
 *
 * The column names carry the measured/estimated split deliberately. Anyone
 * reading this schema months from now should be able to tell which numbers
 * came from a counter and which from a calculation, without going to the
 * code — the embedding API reports no usage, so the estimates are all there
 * is, and a column called `tokens` would quietly claim otherwise.
 */
const CREATE_TABLE_STATEMENT =
  `CREATE TABLE IF NOT EXISTS ${API_USAGE_TABLE} (` +
  "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
  "  timestamp TEXT NOT NULL," +
  "  service TEXT NOT NULL," +
  "  model TEXT NOT NULL," +
  "  operation TEXT NOT NULL," +
  "  trigger_reason TEXT NOT NULL," +
  "  calls INTEGER NOT NULL," +
  "  items INTEGER NOT NULL," +
  "  characters INTEGER NOT NULL," +
  "  estimated_tokens INTEGER NOT NULL," +
  "  estimated_units REAL NOT NULL," +
  "  unit_name TEXT NOT NULL" +
  ")";

const INSERT_STATEMENT =
  `INSERT INTO ${API_USAGE_TABLE} ` +
  "(timestamp, service, model, operation, trigger_reason, calls, items, " +
  "characters, estimated_tokens, estimated_units, unit_name) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/**
 * Build a sink that writes usage to D1.
 *
 * @param database - The bound D1 database.
 * @returns A sink suitable for the memory server's `usageSink`.
 */
export function d1UsageSink(database: D1Database): UsageSink {
  return async (usage: ApiUsage) => {
    await database.batch([
      database.prepare(CREATE_TABLE_STATEMENT),
      database
        .prepare(INSERT_STATEMENT)
        .bind(
          usage.timestamp,
          usage.service,
          usage.model,
          usage.operation,
          usage.trigger,
          usage.calls,
          usage.items,
          usage.characters,
          usage.estimatedTokens,
          usage.estimatedUnits,
          usage.unitName,
        ),
    ]);
  };
}

/**
 * Read usage since a given time, newest first.
 *
 * Takes a cutoff rather than a row count because the question this answers is
 * always about a period — "how much today" — and the free allowance resets at
 * 00:00 UTC. A row limit would answer a different question badly.
 *
 * @param database - The bound D1 database.
 * @param options.since - ISO 8601 cutoff, typically the start of the UTC day.
 * @returns Usage rows since the cutoff. Empty when there are none, including
 *   when the table has yet to be created.
 */
export async function usageSince(
  database: D1Database,
  options: { since: string },
): Promise<ApiUsage[]> {
  try {
    const result = await database
      .prepare(
        "SELECT timestamp, service, model, operation, " +
          "trigger_reason AS trigger, calls, items, characters, " +
          "estimated_tokens AS estimatedTokens, " +
          "estimated_units AS estimatedUnits, unit_name AS unitName " +
          `FROM ${API_USAGE_TABLE} WHERE timestamp >= ? ORDER BY id DESC`,
      )
      .bind(options.since)
      .all<ApiUsage>();
    return result.results ?? [];
  } catch {
    // Created on first write, so "no such table" and "nothing used yet" are
    // the same state. Reporting an error for the healthy case would be a
    // small lie of the kind that wastes an afternoon.
    return [];
  }
}

/**
 * The start of the current UTC day, as an ISO 8601 timestamp.
 *
 * The allowance resets at 00:00 UTC, so that is the only cutoff whose total
 * lines up with the limit it is checked against. A local-midnight or
 * rolling-window figure would be a number that answers no question anyone has.
 *
 * @param now - The current time, in milliseconds.
 * @returns The ISO timestamp of the most recent 00:00 UTC.
 */
export function startOfUtcDay(now: number): string {
  return `${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`;
}
