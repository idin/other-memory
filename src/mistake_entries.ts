/**
 * Reading every mistake entry in a fixed number of requests.
 *
 * A Cloudflare Worker may make at most 50 subrequests per invocation. Reading
 * the log one file at a time spends one subrequest per entry, so the cost
 * grows with the log — and on 2026-08-27, at 45 entries, the digest needed 47
 * and failed with "Too many subrequests by single Worker invocation".
 *
 * The shape of that failure is what makes it worth a module of its own. The
 * digest exists to compress a log that has grown, so the tool broke precisely
 * when it became worth running; and the count that rides along with every
 * tool response was reading the same way, which put every tool on the server
 * one entry from the same ceiling.
 *
 * A batch size would only move the ceiling — any fixed batch is exceeded by a
 * large enough log, reintroducing the same bug later. GraphQL removes it
 * instead: aliased `Blob` objects return every file's text in one request, so
 * the cost is two requests whether the log holds five entries or five hundred.
 */

import { githubClient } from "./github_client";

import { MISTAKES_PREFIX } from "./layout";
import type { MemoryRepoConfig } from "./memory_repo";

/** One entry, as stored. */
export type MistakeEntry = {
  /** Full path within the repository. */
  path: string;
  /** The file's text. */
  text: string;
};

/**
 * The folder holding the entries, relative to the repository root.
 *
 * Derived from the layout prefix rather than restated, so a layout change
 * moves this with it. The trailing slash is dropped because a GraphQL tree
 * expression addresses the folder itself.
 */
const MISTAKES_FOLDER = MISTAKES_PREFIX.replace(/\/$/, "");

/**
 * The one file in the folder that is documentation rather than an entry.
 */
const FOLDER_README = "README.md";

/**
 * Read every mistake entry.
 *
 * Two requests regardless of the log's size: one listing the folder, one
 * fetching every file's text through aliased blobs.
 *
 * @param config - Where the memory lives.
 * @returns Every entry, ordered by path. Empty when the folder does not
 *   exist — a store that has recorded no mistakes is not an error.
 */
export async function readAllMistakeEntries(
  config: MemoryRepoConfig,
): Promise<MistakeEntry[]> {
  const octokit = githubClient(config.token);

  const listing = await octokit.graphql<{
    repository: {
      object: { entries?: Array<{ name: string; type: string }> } | null;
    };
  }>(
    `query($owner: String!, $repo: String!, $expression: String!) {
       repository(owner: $owner, name: $repo) {
         object(expression: $expression) {
           ... on Tree { entries { name type } }
         }
       }
     }`,
    {
      owner: config.owner,
      repo: config.repo,
      expression: `${config.branch}:${MISTAKES_FOLDER}`,
    },
  );

  const names = (listing.repository.object?.entries ?? [])
    .filter((entry) => entry.type === "blob" && entry.name !== FOLDER_README)
    .map((entry) => entry.name)
    .sort();

  if (names.length === 0) {
    return [];
  }

  // Each file becomes an aliased field in one query. The alias carries the
  // index rather than the filename because a GraphQL alias must be a valid
  // name, and these filenames begin with a digit.
  const fields = names
    .map(
      (name, index) =>
        `f${index}: object(expression: $e${index}) { ... on Blob { text } }`,
    )
    .join("\n");
  const parameters = names
    .map((_, index) => `$e${index}: String!`)
    .join(", ");
  const variables: Record<string, string> = {
    owner: config.owner,
    repo: config.repo,
  };
  names.forEach((name, index) => {
    variables[`e${index}`] = `${config.branch}:${MISTAKES_FOLDER}/${name}`;
  });

  const contents = await octokit.graphql<{
    repository: Record<string, { text?: string } | null>;
  }>(
    `query($owner: String!, $repo: String!, ${parameters}) {
       repository(owner: $owner, name: $repo) {
         ${fields}
       }
     }`,
    variables,
  );

  const entries: MistakeEntry[] = [];
  names.forEach((name, index) => {
    const blob = contents.repository[`f${index}`];
    // A null blob means the path resolved to something that is not a file.
    // Skipped rather than recorded as empty, so it cannot be miscounted as an
    // undigested entry.
    if (!blob?.text) {
      return;
    }
    entries.push({ path: `${MISTAKES_FOLDER}/${name}`, text: blob.text });
  });
  return entries;
}
