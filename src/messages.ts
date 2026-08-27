import { Octokit } from "octokit";

import { githubClient } from "./github_client";

import { assertFilenameFits } from "./filename_limit";

import { agentDirectoryName, matchAgentName } from "./agent_names";
import { ARCHIVE_PREFIX, INBOX_PREFIX, assertWellFormed } from "./layout";
import type { MemoryRepoConfig } from "./memory_repo";
import { commitTreeChanges } from "./memory_tree";

/**
 * Messages passed between chats and agents. Deliberately separate from
 * memory/: memory is what is true about the user, this is transient
 * correspondence that gets consumed and filed away.
 *
 * Layout:
 *   messages/inbox/<recipient>/<timestamp>_<sender>_<slug>.md
 *   messages/archive/<recipient>/<same filename>
 *
 * Reading does not remove anything. Archiving moves the file, so nothing is
 * lost and the inbox reflects only what is still outstanding.
 */


export type MessageSummary = {
  path: string;
  filename: string;
  sender: string;
  recipient: string;
  subject: string;
  sentAt: string;
};

export type SendResult = {
  path: string;
  commitSha: string;
  recipient: string;
};

/**
 * Slug used in the filename so an inbox listing is readable at a glance.
 *
 * No length limit here. This used to slice at 48 characters, which produced
 * subjects cut mid-word with nothing said about it. The limit belongs on the
 * finished filename, where the timestamp and sender are also counted.
 */
function subjectSlug(subject: string): string {
  const slug = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug.length > 0 ? slug : "message";
}

/**
 * Timestamp used for ordering and for the filename. Generated here rather
 * than by a caller, so ordering cannot be gamed or mistyped.
 */
function stamp(now: number): { iso: string; fileSafe: string } {
  const iso = new Date(now).toISOString();
  return { iso, fileSafe: iso.replace(/[:.]/g, "-") };
}

/**
 * The filename for a message. Built here, never supplied by a caller — an
 * agent choosing filenames produces drift, since the next one will choose
 * differently.
 *
 * Shape is `<iso-timestamp>_<sender>_<subject-slug>.md`. Hyphens appear only
 * inside the timestamp; everything else is snake_case. Sorting by filename
 * therefore sorts by time.
 */
export function buildMessageFilename(
  sender: string,
  subject: string,
  now: number,
): string {
  const { fileSafe } = stamp(now);
  const filename = `${fileSafe}_${sender}_${subjectSlug(subject)}.md`;
  return assertFilenameFits(filename, `A message subject of "${subject}"`);
}

/**
 * Recover sender, subject and time from a filename. Degrades rather than
 * throwing, so one hand-created file cannot break an inbox listing.
 */
export function parseMessageFilename(filename: string): {
  sender: string;
  subject: string;
  sentAt: string;
} {
  const withoutExtension = filename.replace(/\.md$/, "");
  const [stampPart, senderPart, ...slugParts] = withoutExtension.split("_");

  return {
    sender: senderPart ?? "unknown",
    subject: (slugParts.join("_") || "message").replace(/_/g, " "),
    sentAt: restoreIso(stampPart ?? ""),
  };
}

export async function sendMessage(
  config: MemoryRepoConfig,
  options: {
    from: string;
    to: string;
    subject: string;
    body: string;
    now: number;
  },
): Promise<SendResult> {
  const sender = agentDirectoryName(options.from);
  const recipient = agentDirectoryName(options.to);

  if (options.body.trim().length === 0) {
    throw new Error("Refusing to send an empty message.");
  }
  if (options.subject.trim().length === 0) {
    throw new Error("A message needs a subject.");
  }

  const { iso } = stamp(options.now);
  const filename = buildMessageFilename(sender, options.subject, options.now);
  const path = `${INBOX_PREFIX}${recipient}/${filename}`;

  const content =
    "---\n"
    + `from: ${sender}\n`
    + `to: ${recipient}\n`
    + `subject: ${options.subject.trim()}\n`
    + `sent_at: ${iso}\n`
    + "---\n\n"
    + `${options.body.trim()}\n`;

  const octokit = githubClient(config.token);
  const commitSha = await commitTreeChanges(
    octokit,
    config,
    `chore: message from ${sender} to ${recipient}`,
    [{ path, content }],
  );

  return { path, commitSha, recipient };
}

/** Recipients that currently have at least one message waiting. */
export async function listMailboxes(
  config: MemoryRepoConfig,
): Promise<string[]> {
  const paths = await inboxPaths(config);
  const mailboxes = new Set<string>();
  for (const path of paths) {
    const rest = path.slice(INBOX_PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash > 0) {
      mailboxes.add(rest.slice(0, slash));
    }
  }
  return [...mailboxes].sort();
}

/**
 * Messages waiting for a recipient, oldest first. Resolves the name fuzzily,
 * so "Ada", "ada" and "A_D_A" all find the same mailbox, and reports near
 * misses rather than silently returning an empty inbox for a typo.
 */
export async function listInbox(
  config: MemoryRepoConfig,
  recipient: string,
): Promise<{ resolved: string | null; near: string[]; messages: MessageSummary[] }> {
  const mailboxes = await listMailboxes(config);
  const match = matchAgentName(recipient, mailboxes);

  if (!match.exact) {
    return { resolved: null, near: match.near, messages: [] };
  }

  const prefix = `${INBOX_PREFIX}${match.exact}/`;
  const paths = (await inboxPaths(config)).filter((path) =>
    path.startsWith(prefix),
  );

  const messages = paths
    .map((path) => summarize(path, match.exact as string))
    .sort((left, right) => left.filename.localeCompare(right.filename));

  return { resolved: match.exact, near: [], messages };
}

export async function readMessage(
  config: MemoryRepoConfig,
  path: string,
): Promise<{ path: string; content: string }> {
  assertMessagePath(path);
  const octokit = githubClient(config.token);
  const response = await octokit.rest.repos.getContent({
    owner: config.owner,
    repo: config.repo,
    path,
    ref: config.branch,
  });
  const file = response.data;
  if (Array.isArray(file) || file.type !== "file") {
    throw new Error(`Not a message file: ${path}`);
  }
  const binary = atob(file.content.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return { path, content: new TextDecoder().decode(bytes) };
}

/** Move a message out of the inbox, keeping its content and history. */
export async function archiveMessage(
  config: MemoryRepoConfig,
  path: string,
): Promise<{ from: string; to: string; commitSha: string }> {
  assertMessagePath(path);
  if (!path.startsWith(INBOX_PREFIX)) {
    throw new Error(`Already archived: ${path}`);
  }

  const destination = `${ARCHIVE_PREFIX}${path.slice(INBOX_PREFIX.length)}`;
  const existing = await readMessage(config, path);

  const octokit = githubClient(config.token);
  const commitSha = await commitTreeChanges(
    octokit,
    config,
    `chore: archive message ${path.split("/").pop()}`,
    [
      { path, sha: null },
      { path: destination, content: existing.content },
    ],
  );

  return { from: path, to: destination, commitSha };
}

function assertMessagePath(path: string): void {
  assertWellFormed(path);
  if (!path.startsWith(INBOX_PREFIX) && !path.startsWith(ARCHIVE_PREFIX)) {
    throw new Error(
      `Not a message path: ${path}. Expected it to start with ${INBOX_PREFIX} `
        + `or ${ARCHIVE_PREFIX}.`,
    );
  }
  if (!path.endsWith(".md")) {
    throw new Error(`Message files are markdown: ${path}`);
  }
}

/** Pull sender, subject and time back out of the filename. */
function summarize(path: string, recipient: string): MessageSummary {
  const filename = path.split("/").pop() ?? path;
  return { path, filename, recipient, ...parseMessageFilename(filename) };
}

/** Turn a file-safe stamp back into a readable ISO instant. */
function restoreIso(fileSafe: string): string {
  const match = fileSafe.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
  );
  if (!match) {
    return fileSafe;
  }
  const [, year, month, day, hour, minute, second, millisecond] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}Z`;
}

async function inboxPaths(config: MemoryRepoConfig): Promise<string[]> {
  const octokit = githubClient(config.token);
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
        entry.type === "blob" && (entry.path ?? "").startsWith(INBOX_PREFIX),
    )
    .map((entry) => entry.path as string);
}
