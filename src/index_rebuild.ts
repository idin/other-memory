/**
 * Keeping the index in step with the repository.
 *
 * Git already tracks what changed, so nothing here hashes files or compares
 * timestamps: `compare` between the built commit and HEAD names the changed
 * paths and says how each changed. That also covers edits made outside this
 * server — a commit from an editor or another machine looks identical to one
 * a tool wrote.
 *
 * The unit is the file. Chunk-level invalidation was considered and rejected:
 * an edit can shift chunk boundaries so every later chunk looks new, and at
 * this store's size re-chunking one file costs a handful of embedding calls.
 * Working at file level also means sibling links, which are within a file,
 * can never straddle the invalidation boundary.
 */

import { Octokit } from "octokit";

import { githubClient } from "./github_client";

import { NAMESPACE } from "./layout";
import type { MemoryRepoConfig } from "./memory_repo";

/**
 * Where GitHub truncates a comparison's file list.
 *
 * Documented rather than discovered: the API returns at most 300 file
 * entries, and a comparison spanning more than 250 commits is itself
 * truncated. At the limit the list is a subset with nothing to distinguish it
 * from a complete one, so reaching it means falling back to a full rebuild
 * rather than trusting it.
 */
const COMPARISON_FILE_LIMIT = 300;

/** What to do with one changed file. */
export type FileChange =
  | { kind: "upsert"; path: string }
  | { kind: "delete"; path: string };

/** Why a build is doing what it is doing. */
export type RebuildMode = "full" | "incremental" | "up_to_date";

/**
 * A file entry as `compare` reports it.
 *
 * Narrowed to the fields that matter, so a caller can pass the API response
 * through unchanged.
 */
export type ComparedFile = {
  filename: string;
  status: string;
  previous_filename?: string;
};

/**
 * Turn a comparison into work.
 *
 * Renames are the case worth stating: git reports one entry with both names,
 * and treating it as a simple change would leave the old path's rows behind
 * as orphans — searchable under a name that no longer exists. The
 * `rename_memory_subject` tool makes that a real path rather than a
 * hypothetical.
 *
 * @param files - Changed files, as `compare` reported them.
 * @returns What to do, restricted to files inside the namespace.
 */
export function planChanges(files: ComparedFile[]): FileChange[] {
  const changes: FileChange[] = [];

  for (const file of files) {
    const inNamespace = (path: string) => path.startsWith(NAMESPACE);

    switch (file.status) {
      case "added":
      case "modified":
      case "changed":
      case "copied":
        // Modified is an upsert rather than a delete plus an insert because
        // the store deletes by path before inserting. One entry, not two.
        if (inNamespace(file.filename)) {
          changes.push({ kind: "upsert", path: file.filename });
        }
        break;

      case "removed":
        if (inNamespace(file.filename)) {
          changes.push({ kind: "delete", path: file.filename });
        }
        break;

      case "renamed":
        if (file.previous_filename && inNamespace(file.previous_filename)) {
          changes.push({ kind: "delete", path: file.previous_filename });
        }
        if (inNamespace(file.filename)) {
          changes.push({ kind: "upsert", path: file.filename });
        }
        break;

      case "unchanged":
        break;

      default:
        // An unrecognised status is treated as a change rather than ignored.
        // Being wrong here costs one re-chunk; ignoring it costs a stale row
        // nobody finds out about.
        if (inNamespace(file.filename)) {
          changes.push({ kind: "upsert", path: file.filename });
        }
    }
  }

  return changes;
}

/** What a comparison concluded. */
export type ComparisonPlan = {
  mode: RebuildMode;
  changes: FileChange[];
  /** Why a full rebuild, when that is the answer. Null otherwise. */
  reason: string | null;
};

/**
 * Work out what needs rebuilding between two commits.
 *
 * Falls back to a full rebuild in four cases, each because a partial index
 * reports success while covering only part of the store:
 *
 * - Nothing has been built yet.
 * - The comparison is truncated. GitHub caps `files` at 300 entries and the
 *   comparison at 250 commits.
 * - The base commit is unreachable, which happens after a force-push. The
 *   revert tool makes history rewriting a real operation here.
 * - The change set is larger than the index can carry forward in one call.
 *   A store with a bound-parameter cap (D1's is 100) cannot exclude more
 *   paths than fit in one `carryForward` statement; asking it to would fail
 *   outright rather than index only part of the store, so the fallback here
 *   is what keeps a large batch change — a folder-wide rename, say —
 *   from failing the whole search instead of just costing a full reindex.
 *
 * @param config - Where the memory lives.
 * @param builtSha - The commit the index was last built from, or null.
 * @param headSha - The commit to bring it to.
 * @param maxCarryForwardExclusions - The index's own limit on how many
 *   paths `carryForward` can exclude in one call, or `null` for no limit.
 * @returns What to do.
 */
export async function planRebuild(
  config: MemoryRepoConfig,
  builtSha: string | null,
  headSha: string,
  maxCarryForwardExclusions: number | null = null,
): Promise<ComparisonPlan> {
  if (!builtSha) {
    return {
      mode: "full",
      changes: [],
      reason: "Nothing has been indexed yet.",
    };
  }

  if (builtSha === headSha) {
    return { mode: "up_to_date", changes: [], reason: null };
  }

  const octokit = githubClient(config.token);

  try {
    const comparison = await octokit.rest.repos.compareCommitsWithBasehead({
      owner: config.owner,
      repo: config.repo,
      basehead: `${builtSha}...${headSha}`,
    });

    const files = comparison.data.files ?? [];
    // `files` is capped at 300 entries and the comparison at 250 commits.
    // Past either, the list is a subset with nothing marking it as one.
    if (files.length >= COMPARISON_FILE_LIMIT) {
      return {
        mode: "full",
        changes: [],
        reason:
          `The comparison returned ${files.length} files, at or past the `
          + "limit where the list is truncated without saying so.",
      };
    }

    const changes = planChanges(files as ComparedFile[]);
    if (
      maxCarryForwardExclusions !== null
      && changes.length > maxCarryForwardExclusions
    ) {
      return {
        mode: "full",
        changes: [],
        reason:
          `${changes.length} files changed since the last build, past the `
          + `${maxCarryForwardExclusions} the index can carry forward in one `
          + "call, so the whole store is being reindexed.",
      };
    }

    return {
      mode: "incremental",
      changes,
      reason: null,
    };
  } catch (error) {
    // A 404 means the base commit is no longer reachable, which is what a
    // force-push or a revert leaves behind.
    return {
      mode: "full",
      changes: [],
      reason:
        `Could not compare ${builtSha.slice(0, 7)} with `
        + `${headSha.slice(0, 7)} (${(error as Error).message}). History may `
        + "have been rewritten, so the whole store is being reindexed.",
    };
  }
}

/**
 * Read the current head commit.
 *
 * @param config - Where the memory lives.
 * @returns The branch's head sha.
 */
export async function readHeadCommit(
  config: MemoryRepoConfig,
): Promise<string> {
  const octokit = githubClient(config.token);
  const branch = await octokit.rest.repos.getBranch({
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
  });
  return branch.data.commit.sha;
}
