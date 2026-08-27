/**
 * Reading the mistake log, and knowing when it is worth digesting.
 *
 * The log records where an agent got something wrong. On its own that is a
 * confessional: entries accumulate, nobody rereads them, and the same mistake
 * is made again by an agent that never saw the entry describing it.
 *
 * A digest is what makes it a loop — patterns are drawn out of the entries and
 * turned into something that prevents a recurrence, and the entries that
 * contributed are marked as read. The user decides to run one. This file only
 * reports what is there and how much of it is undigested.
 */

import { Octokit } from "octokit";

import { githubClient } from "./github_client";

import { MISTAKES_PREFIX } from "./layout";
import type { MemoryRepoConfig } from "./memory_repo";

/**
 * Entries above which the server stops merely reporting the count and says a
 * digest is worth running.
 *
 * Ten rather than a rounder number for a reason worth stating: fourteen
 * entries accumulated in a single session on 2026-08-12, and they collapsed
 * into roughly five patterns. Below ten there is usually not enough repetition
 * to tell a pattern from a coincidence, which is the distinction a digest
 * exists to make.
 */
export const DIGEST_RECOMMENDED_AT = 10;

/** Marker a digested entry carries, so counting needs no separate index. */
export const DIGESTED_MARKER = "Digested ";

export type MistakeSummary = {
  total: number;
  undigested: number;
  /** Present only when a digest is worth running, so callers can pass it on. */
  recommendation: string | null;
};

/**
 * Count the entries, and say whether a digest is due.
 *
 * The state lives in the files themselves rather than in a separate index. An
 * index is a second thing to keep true, and the first time it disagrees with
 * the files nobody knows which to believe.
 *
 * @param config - Where the memory lives.
 * @returns Totals, and a recommendation when one is warranted.
 */
export async function summariseMistakes(
  config: MemoryRepoConfig,
): Promise<MistakeSummary> {
  const octokit = githubClient(config.token);

  let entries: string[];
  try {
    const branch = await octokit.rest.repos.getBranch({
      owner: config.owner,
      repo: config.repo,
      branch: config.branch,
    });
    const tree = await octokit.rest.git.getTree({
      owner: config.owner,
      repo: config.repo,
      tree_sha: branch.data.commit.sha,
      recursive: "true",
    });
    entries = (tree.data.tree ?? [])
      .filter((node) => node.type === "blob")
      .map((node) => node.path ?? "")
      .filter(
        (path) =>
          path.startsWith(MISTAKES_PREFIX) && !path.endsWith("/README.md"),
      );
  } catch {
    // No folder yet is the same state as no entries, and reporting an error
    // for a repository that simply has not made a mistake yet would be its own
    // small lie.
    return { total: 0, undigested: 0, recommendation: null };
  }

  const contents = await Promise.all(
    entries.map((path) => readEntry(octokit, config, path)),
  );
  const undigested = contents.filter(
    (text) => !text.includes(DIGESTED_MARKER),
  ).length;

  return {
    total: entries.length,
    undigested,
    recommendation:
      undigested >= DIGEST_RECOMMENDED_AT
        ? `${undigested} undigested mistakes. That is enough repetition `
          + "for patterns to be visible rather than guessed at — worth running "
          + "a digest, if Idin wants one."
        : null,
  };
}

/**
 * One line describing the state of the log, for attaching to a tool response.
 *
 * Kept short deliberately. This rides along with unrelated answers, and a
 * paragraph on every call is noise that gets skimmed past — including on the
 * call where it mattered.
 *
 * @param summary - What `summariseMistakes` found.
 * @returns A single line, or null when there is nothing worth saying.
 */
export function describeMistakeState(
  summary: MistakeSummary,
): string | null {
  if (summary.undigested === 0) {
    return null;
  }
  if (summary.recommendation) {
    return summary.recommendation;
  }
  return `${summary.undigested} undigested mistake${
    summary.undigested === 1 ? "" : "s"
  }.`;
}

/**
 * Read one entry's text.
 *
 * @param octokit - Authenticated client.
 * @param config - Where the memory lives.
 * @param path - The entry to read.
 * @returns The file's text, or an empty string if it cannot be read — an
 *   unreadable entry counts as undigested, which errs toward reporting work
 *   rather than hiding it.
 */
async function readEntry(
  octokit: Octokit,
  config: MemoryRepoConfig,
  path: string,
): Promise<string> {
  try {
    const file = await octokit.rest.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path,
      ref: config.branch,
    });
    if (Array.isArray(file.data) || file.data.type !== "file") {
      return "";
    }
    return atob(file.data.content.replace(/\n/g, ""));
  } catch {
    return "";
  }
}
