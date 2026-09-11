import { Octokit } from "octokit";

import { githubClient } from "./github_client";

import { decodeBase64, encodeBase64 } from "./base64";
import {
  ALLOWED_EXTENSIONS,
  INSTRUCTIONS_PREFIX,
  NAMESPACE,
  assertWellFormed,
  describeLayout,
  isHiddenFromAgents,
  isWithinNamespace,
} from "./layout";

export type MemoryRepoConfig = {
  owner: string;
  repo: string;
  branch: string;
  token: string;
};

/**
 * Anything inside the namespace can be read. Nothing outside it can, even
 * though the token could — the repo may hold things that are none of this
 * server's business.
 */
export function assertReadable(path: string): void {
  assertWellFormed(path);
  if (!isWithinNamespace(path)) {
    throw new Error(
      `Path not readable by this server: ${path}. `
        + `It only reads inside ${NAMESPACE}.`,
    );
  }
  if (isHiddenFromAgents(path)) {
    throw new Error(`${path} is not visible to any agent-facing tool.`);
  }
}

/**
 * Writable is the same set, minus the instructions. Those exist so the
 * assistant can read the rules it is meant to follow; letting it rewrite those
 * rules would defeat the point.
 *
 * The check is on the prefix, not on one filename. The instructions are a
 * folder, and a guard that named a single file would leave every rule in it
 * writable.
 */
export function assertAppendable(path: string): void {
  assertWellFormed(path);
  if (path.startsWith(INSTRUCTIONS_PREFIX)) {
    throw new Error(
      `${path} is one of the rules this server follows and is read-only to it. `
        + "Edit it yourself if the rules should change.",
    );
  }
  if (isHiddenFromAgents(path)) {
    throw new Error(`${path} is not visible to any agent-facing tool.`);
  }
  if (!isWithinNamespace(path)) {
    throw new Error(
      `Path not appendable by this server: ${path}. `
        + `It only writes inside ${NAMESPACE}.`,
    );
  }
}

export function describeReadablePaths(): string {
  return `anything under ${NAMESPACE} — ${describeLayout()}`;
}

export function describeAppendablePaths(): string {
  return (
    `anything under ${NAMESPACE} except ${INSTRUCTIONS_PREFIX} — `
    + describeLayout()
  );
}

/**
 * Read one memory file. Returns its full text plus the blob sha, which the
 * caller needs in order to append without clobbering a concurrent edit.
 */
export async function readMemory(
  config: MemoryRepoConfig,
  path: string,
): Promise<{ path: string; content: string; sha: string }> {
  assertReadable(path);
  const octokit = githubClient(config.token);

  const response = await octokit.rest.repos.getContent({
    owner: config.owner,
    repo: config.repo,
    path,
    ref: config.branch,
  });

  const file = response.data;
  if (Array.isArray(file) || file.type !== "file") {
    throw new Error(`Not a file: ${path}`);
  }

  return {
    path,
    content: decodeBase64(file.content),
    sha: file.sha,
  };
}

/**
 * Append text to the end of a memory file and commit directly to the branch.
 * Creates the file first if it does not exist yet.
 *
 * Appends rather than replaces: this server has no tool that can delete or
 * rewrite existing content, so a compromised or confused caller cannot erase
 * history. Corrections are made by appending a superseding entry, per the
 * repo's "superseded, not deleted" rule.
 *
 * Auto-creating on a missing path, rather than erroring and pointing the
 * caller at `create_memory_file`, closes a mistake this way of splitting the
 * two tools invited: an agent recording something new has no way to know in
 * advance whether the target file already exists, and guessing wrong used to
 * fail with a bare GitHub 404 — "Not Found -
 * .../rest/repos/contents#get-repository-content" — that named neither the
 * cause nor the fix. Two attempts in a row failed that way on 2026-09-11 and
 * the write was lost both times. "Append this fact" has one obviously correct
 * behaviour regardless of whether the file happens to exist yet, so the tool
 * now provides it directly instead of asking the caller to know the answer
 * first.
 */
export async function appendMemory(
  config: MemoryRepoConfig,
  path: string,
  text: string,
  commitMessage: string,
): Promise<{ path: string; commitSha: string; bytesAppended: number }> {
  assertAppendable(path);

  if (path.endsWith("/")) {
    throw new Error("Provide a file path, not a folder.");
  }
  if (!ALLOWED_EXTENSIONS.some((extension) => path.endsWith(extension))) {
    throw new Error(
      `Memory files must end in ${ALLOWED_EXTENSIONS.join(" or ")} — got: ${path}`,
    );
  }
  if (text.trim().length === 0) {
    throw new Error("Refusing to append empty text.");
  }

  const octokit = githubClient(config.token);

  let existing: { content: string; sha: string | undefined };
  try {
    existing = await readMemory(config, path);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
    existing = { content: "", sha: undefined };
  }

  const separator =
    existing.content.length === 0 || existing.content.endsWith("\n") ? "" : "\n";
  const updated = `${existing.content}${separator}${text.trimEnd()}\n`;

  const response = await octokit.rest.repos.createOrUpdateFileContents({
    owner: config.owner,
    repo: config.repo,
    path,
    message: commitMessage,
    content: encodeBase64(updated),
    // Omitted when the file is being created: GitHub's contents API treats a
    // provided sha as "replace this exact blob" and rejects a create with
    // one. Present when appending, so a concurrent edit is still caught
    // rather than silently overwritten.
    ...(existing.sha ? { sha: existing.sha } : {}),
    branch: config.branch,
  });

  const commitSha = response.data.commit.sha;
  if (!commitSha) {
    throw new Error(`Commit to ${path} returned no sha.`);
  }

  return {
    path,
    commitSha,
    bytesAppended: text.trimEnd().length,
  };
}

/** Whether an error means GitHub could not find the requested file. */
function isMissingFile(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 404;
}


/**
 * Whether an error means GitHub is refusing for rate reasons.
 *
 * Distinguished from every other failure because the response differs: a
 * rate limit is temporary and says nothing about the request, so the only
 * useful reaction is to wait. Retrying at the ordinary pace spends the quota
 * being waited on, which is how an index rebuild exhausted an hour of the
 * API allowance on 2026-08-26 and left every tool hanging.
 *
 * Octokit reports these as 403 or 429, and the message wording varies
 * between the primary hourly limit, secondary abuse limits, and the
 * per-endpoint request quota — so both are matched.
 *
 * @param error - Whatever was thrown.
 * @returns True when GitHub is rate limiting rather than rejecting.
 */
export function isRateLimited(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  if (status === 429) {
    return true;
  }
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  // Matched on wording rather than on the 403 alone, because a 403 is also
  // how GitHub answers a token that lacks permission — durable, and not
  // something waiting would fix.
  return (
    message.includes("rate limit")
    || message.includes("quota exhausted")
    || message.includes("secondary rate")
    || message.includes("abuse detection")
  );
}
