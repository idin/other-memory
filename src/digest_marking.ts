/**
 * Closing the digest loop.
 *
 * Gathering the entries was only ever half of a digest. The other half is
 * recording which entries were considered and what each produced, so the next
 * digest starts from what is genuinely new.
 *
 * That half was missing. `digestedNote` existed and was tested, and nothing
 * called it — the marker was read by two filters and written by nothing. So
 * the count only ever rose: 47 entries and none digested, with every future
 * digest re-reading entries already considered and deliberately answered with
 * nothing.
 *
 * The cost is not just noise. The recurrence check is the digest's most
 * valuable output — a pattern reappearing *after* a rule was written to prevent
 * it means that rule failed — and it can only be seen when earlier entries
 * carry what they produced. Unmarked, every entry looks equally new, and the
 * one signal worth having is invisible.
 *
 * Marking happens after Idin rules, never before. Nothing here decides what a
 * digest adopts; it records what he decided.
 */

import { githubClient } from "./github_client";

import { digestedNote } from "./digest";
import type { MemoryRepoConfig } from "./memory_repo";
import { commitTreeChanges } from "./memory_tree";
import { readAllMistakeEntries } from "./mistake_entries";
import { DIGESTED_MARKER } from "./mistakes";

/** One entry's outcome, as the digest decided it. */
export type DigestOutcome = {
  /** Repo-relative path of the mistake entry. */
  path: string;
  /**
   * What this entry contributed to, or an empty list.
   *
   * Empty is a real outcome, not a missing one. An entry the digest considered
   * and deliberately answered with nothing must still be marked, or it returns
   * at every future digest and the count never falls.
   */
  produced: string[];
};

export type MarkingResult = {
  /** Entries that were marked. */
  marked: string[];
  /** Entries skipped because they already carried a marker. */
  alreadyDigested: string[];
  /** Paths that matched no entry in the store. */
  unknown: string[];
  /** The commit, or null when there was nothing to write. */
  commitSha: string | null;
};

/**
 * Mark entries as digested, in one commit.
 *
 * @param options.config - Where the memory lives.
 * @param options.date - The digest's date, as `YYYY-MM-DD`. Passed in rather
 *   than read from the clock so the caller owns it and the result is
 *   reproducible.
 * @param options.outcomes - What the digest decided for each entry.
 * @param options.commitMessage - Conventional Commits format.
 * @returns What was marked, what was skipped, and the commit.
 */
export async function markEntriesDigested(options: {
  config: MemoryRepoConfig;
  date: string;
  outcomes: DigestOutcome[];
  commitMessage: string;
}): Promise<MarkingResult> {
  const { config, date, outcomes, commitMessage } = options;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Digest date must be YYYY-MM-DD, got: ${date}`);
  }
  if (outcomes.length === 0) {
    throw new Error("Refusing to mark nothing digested.");
  }

  const entries = await readAllMistakeEntries(config);
  const byPath = new Map(entries.map((entry) => [entry.path, entry.text]));

  const marked: string[] = [];
  const alreadyDigested: string[] = [];
  const unknown: string[] = [];
  const changes: Array<{ path: string; content: string }> = [];

  for (const outcome of outcomes) {
    const text = byPath.get(outcome.path);
    if (text === undefined) {
      unknown.push(outcome.path);
      continue;
    }
    // A second marker would make the entry read as digested twice, on two
    // different dates, with no way to tell which was real.
    if (text.includes(DIGESTED_MARKER)) {
      alreadyDigested.push(outcome.path);
      continue;
    }
    const note = digestedNote({ date, produced: outcome.produced });
    const separator = text.endsWith("\n") ? "" : "\n";
    changes.push({ path: outcome.path, content: `${text}${separator}${note}` });
    marked.push(outcome.path);
  }

  if (changes.length === 0) {
    return { marked, alreadyDigested, unknown, commitSha: null };
  }

  // One commit for every entry rather than one each. A per-file append would
  // cost two subrequests per entry, which at this log's size is the ceiling
  // that broke the gather it is paired with.
  const commitSha = await commitTreeChanges(
    githubClient(config.token),
    config,
    commitMessage,
    changes,
  );

  return { marked, alreadyDigested, unknown, commitSha };
}
