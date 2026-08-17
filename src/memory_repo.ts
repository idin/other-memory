import { Octokit } from "octokit";

import { decodeBase64, encodeBase64 } from "./base64";
import {
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
  const octokit = new Octokit({ auth: config.token });

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
 *
 * Appends rather than replaces: this server has no tool that can delete or
 * rewrite existing content, so a compromised or confused caller cannot erase
 * history. Corrections are made by appending a superseding entry, per the
 * repo's "superseded, not deleted" rule.
 */
export async function appendMemory(
  config: MemoryRepoConfig,
  path: string,
  text: string,
  commitMessage: string,
): Promise<{ path: string; commitSha: string; bytesAppended: number }> {
  assertAppendable(path);

  if (text.trim().length === 0) {
    throw new Error("Refusing to append empty text.");
  }

  const octokit = new Octokit({ auth: config.token });
  const existing = await readMemory(config, path);

  const separator = existing.content.endsWith("\n") ? "" : "\n";
  const updated = `${existing.content}${separator}${text.trimEnd()}\n`;

  const response = await octokit.rest.repos.createOrUpdateFileContents({
    owner: config.owner,
    repo: config.repo,
    path,
    message: commitMessage,
    content: encodeBase64(updated),
    sha: existing.sha,
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

