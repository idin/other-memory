import { Octokit } from "octokit";

import { decodeBase64, encodeBase64 } from "./base64";
import {
  ALLOWED_EXTENSIONS,
  INSTRUCTIONS_PREFIX,
  NAMESPACE,
  assertWellFormed,
  isHiddenFromAgents,
  isWithinNamespace,
} from "./layout";
import type { MemoryRepoConfig } from "./memory_repo";

/**
 * Structural changes — create, move, delete — are confined to the namespace,
 * same as reads and writes. The rest of the repo may contain anything at all
 * and is none of this server's business.
 */
export function assertManagedPath(path: string): void {
  assertWellFormed(path);

  if (path.endsWith("/")) {
    throw new Error(
      "Provide a file path, not a folder. Folders are created implicitly by "
        + "creating a file inside them.",
    );
  }
  if (!isWithinNamespace(path)) {
    throw new Error(
      `Structural changes are limited to ${NAMESPACE} — got: ${path}`,
    );
  }
  if (path.startsWith(INSTRUCTIONS_PREFIX)) {
    throw new Error(
      `${path} holds the rules this server follows and must not be moved or `
        + "deleted by it.",
    );
  }
  if (isHiddenFromAgents(path)) {
    throw new Error(
      `${path} is not visible to any agent-facing tool.`,
    );
  }
  if (!ALLOWED_EXTENSIONS.some((extension) => path.endsWith(extension))) {
    throw new Error(
      `Memory files must end in ${ALLOWED_EXTENSIONS.join(" or ")} — got: ${path}`,
    );
  }
}

export type MemoryFileEntry = {
  path: string;
  bytes: number;
};

/** Every file currently under `memory/`, with sizes. */
export async function listMemoryFiles(
  config: MemoryRepoConfig,
): Promise<MemoryFileEntry[]> {
  const octokit = new Octokit({ auth: config.token });
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

  return tree.data.tree
    .filter(
      (entry) =>
        entry.type === "blob"
        && (entry.path ?? "").startsWith(NAMESPACE)
        && !isHiddenFromAgents(entry.path ?? ""),
    )
    .map((entry) => ({
      path: entry.path as string,
      bytes: entry.size ?? 0,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

/** Create a file that does not yet exist. Never overwrites. */
export async function createMemoryFile(
  config: MemoryRepoConfig,
  path: string,
  content: string,
  commitMessage: string,
): Promise<{ path: string; commitSha: string }> {
  assertManagedPath(path);

  const octokit = new Octokit({ auth: config.token });

  if (await pathExists(octokit, config, path)) {
    throw new Error(
      `${path} already exists. Use append_memory to add to it, or choose a `
        + "different path.",
    );
  }

  const response = await octokit.rest.repos.createOrUpdateFileContents({
    owner: config.owner,
    repo: config.repo,
    path,
    message: commitMessage,
    content: encodeBase64(content.endsWith("\n") ? content : `${content}\n`),
    branch: config.branch,
  });

  return { path, commitSha: requireCommitSha(response.data.commit.sha, path) };
}

/**
 * Move a file by writing it at the new path and removing the old one. Both
 * halves land in a single commit so the tree is never left with a duplicate.
 */
export async function moveMemoryFile(
  config: MemoryRepoConfig,
  fromPath: string,
  toPath: string,
  commitMessage: string,
): Promise<{ fromPath: string; toPath: string; commitSha: string }> {
  assertManagedPath(fromPath);
  assertManagedPath(toPath);
  if (fromPath === toPath) {
    throw new Error("Source and destination are the same path.");
  }

  const octokit = new Octokit({ auth: config.token });
  if (await pathExists(octokit, config, toPath)) {
    throw new Error(`${toPath} already exists; refusing to overwrite it.`);
  }

  const commitSha = await commitTreeChanges(octokit, config, commitMessage, [
    { path: fromPath, sha: null },
    { path: toPath, content: await readRaw(octokit, config, fromPath) },
  ]);

  return { fromPath, toPath, commitSha };
}

/** Delete a file. Callers are expected to have confirmed first. */
export async function deleteMemoryFile(
  config: MemoryRepoConfig,
  path: string,
  commitMessage: string,
): Promise<{ path: string; commitSha: string; bytesRemoved: number }> {
  assertManagedPath(path);

  const octokit = new Octokit({ auth: config.token });
  const existing = await octokit.rest.repos.getContent({
    owner: config.owner,
    repo: config.repo,
    path,
    ref: config.branch,
  });

  const file = existing.data;
  if (Array.isArray(file) || file.type !== "file") {
    throw new Error(`Not a file: ${path}`);
  }

  const response = await octokit.rest.repos.deleteFile({
    owner: config.owner,
    repo: config.repo,
    path,
    message: commitMessage,
    sha: file.sha,
    branch: config.branch,
  });

  return {
    path,
    commitSha: requireCommitSha(response.data.commit.sha, path),
    bytesRemoved: file.size ?? 0,
  };
}

async function pathExists(
  octokit: Octokit,
  config: MemoryRepoConfig,
  path: string,
): Promise<boolean> {
  try {
    await octokit.rest.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path,
      ref: config.branch,
    });
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 404) {
      return false;
    }
    throw error;
  }
}

async function readRaw(
  octokit: Octokit,
  config: MemoryRepoConfig,
  path: string,
): Promise<string> {
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
  return decodeBase64(file.content);
}

/**
 * Apply several path changes as one commit. `sha: null` removes a path;
 * `content` writes one. Uses the git data API because the contents API can
 * only touch a single file per commit.
 */
export async function commitTreeChanges(
  octokit: Octokit,
  config: MemoryRepoConfig,
  message: string,
  changes: Array<{ path: string; content?: string; sha?: null }>,
): Promise<string> {
  const branch = await octokit.rest.repos.getBranch({
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
  });
  const baseCommitSha = branch.data.commit.sha;
  const baseTreeSha = branch.data.commit.commit.tree.sha;

  const tree = changes.map((change) =>
    change.sha === null
      ? { path: change.path, mode: "100644" as const, type: "blob" as const, sha: null }
      : {
          path: change.path,
          mode: "100644" as const,
          type: "blob" as const,
          content: change.content ?? "",
        },
  );

  const createdTree = await octokit.rest.git.createTree({
    owner: config.owner,
    repo: config.repo,
    base_tree: baseTreeSha,
    tree,
  });

  const commit = await octokit.rest.git.createCommit({
    owner: config.owner,
    repo: config.repo,
    message,
    tree: createdTree.data.sha,
    parents: [baseCommitSha],
  });

  await octokit.rest.git.updateRef({
    owner: config.owner,
    repo: config.repo,
    ref: `heads/${config.branch}`,
    sha: commit.data.sha,
  });

  return commit.data.sha;
}

function requireCommitSha(sha: string | undefined, path: string): string {
  if (!sha) {
    throw new Error(`Commit touching ${path} returned no sha.`);
  }
  return sha;
}
