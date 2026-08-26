/**
 * Memory that is present but not in the way.
 *
 * Some of the store is worth keeping and not worth reading: work that
 * resolved, correspondence already acted on, entries that have been digested.
 * None of it is secret. It is simply not what anyone is asking about, and a
 * listing that puts it beside current facts makes the current facts harder to
 * find.
 *
 * So this is context economy, not privacy. Idin ruled that distinction on
 * 2026-08-13, and it decides the whole design: there is no gate here, no
 * consent token, no refusal. Deep files are absent from the default listing
 * and readable the moment anyone asks for them by name.
 *
 * That is deliberate rather than a shortcut. A permission system would need
 * consent arriving through a channel the agent does not control, since an
 * agent invents its own tool arguments — and it would be protecting material
 * that nobody decided was sensitive.
 */

import {
  ARCHIVE_PREFIX,
  IDEAS_RESOLVED_PREFIX,
  NAMESPACE,
  PROPOSALS_RESOLVED_PREFIX,
  TODOS_RESOLVED_PREFIX,
} from "./layout";

/**
 * Areas kept out of the default listing.
 *
 * All are things that have already happened. The `resolved/` folder of each
 * work stage holds what finished or was rejected; the message archive is
 * correspondence acted on. Neither is what a question about the user is
 * usually answered from.
 */
export const DEEP_PREFIXES = [
  IDEAS_RESOLVED_PREFIX,
  PROPOSALS_RESOLVED_PREFIX,
  TODOS_RESOLVED_PREFIX,
  ARCHIVE_PREFIX,
] as const;

/**
 * Whether a path is deep.
 *
 * @param path - A repo-relative path.
 * @returns True when the file is kept out of the default listing.
 */
export function isDeep(path: string): boolean {
  return DEEP_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export type DeepSummary = {
  /** How many files are held back, per area. */
  counts: Array<{ prefix: string; files: number }>;
  total: number;
};

/**
 * Count what is being held back, by area.
 *
 * @param paths - Every path in the store.
 * @returns Counts per deep area, and the total.
 */
export function summariseDeep(paths: string[]): DeepSummary {
  const counts = DEEP_PREFIXES.map((prefix) => ({
    prefix,
    files: paths.filter((path) => path.startsWith(prefix)).length,
  })).filter((entry) => entry.files > 0);

  return {
    counts,
    total: counts.reduce((sum, entry) => sum + entry.files, 0),
  };
}

/**
 * The line that tells a reader what was held back and how to reach it.
 *
 * This is the whole of the "gate". An agent that needs something in here has
 * to know it exists, so the count is always shown — hiding files and saying
 * nothing about them would produce an agent confidently answering from a
 * store it could not see all of.
 *
 * @param summary - What is being held back.
 * @returns A line to append to a listing, or null when nothing is held back.
 */
export function describeDeep(summary: DeepSummary): string | null {
  if (summary.total === 0) {
    return null;
  }

  const areas = summary.counts
    .map((entry) => `${entry.files} in ${entry.prefix.replace(NAMESPACE, "")}`)
    .join(", ");

  return (
    `\n${summary.total} further file(s) are not listed above: ${areas}. `
    + "They are resolved work and acted-on correspondence — present and "
    + "readable, just not usually what a question is answered from. Read one "
    + "by path when you need it, or ask for a full listing."
  );
}

/**
 * Filter a listing down to what is worth showing by default.
 *
 * @param paths - Every path in the store.
 * @param options.includeDeep - Whether to include the held-back files.
 * @returns The paths to list.
 */
export function applyDepth(
  paths: string[],
  options: { includeDeep: boolean },
): string[] {
  return options.includeDeep ? paths : paths.filter((path) => !isDeep(path));
}
