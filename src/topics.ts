import { assertFilenameFits } from "./filename_limit";
import {
  CAPTURE_RULES_PREFIX,
  DECISIONS_PREFIX,
  FACTS_PREFIX,
  IDEAS_PREFIX,
  INFRASTRUCTURE_PREFIX,
  MISTAKES_PREFIX,
  PROPOSALS_PREFIX,
  TODOS_PREFIX,
} from "./layout";

/**
 * Where a new file goes, decided here rather than by whoever is writing it.
 *
 * Callers used to pass a path. That meant every agent invented its own
 * conventions — one produced `todos/2026-08-09-check-thing.md`, another
 * `facts/home/kitchen.md`, and neither knew what the last had chosen. The
 * layout drifted because nothing owned it.
 *
 * Now a caller says what kind of thing it is recording and what it is about,
 * and the path is derived. There is no way to pass a path, so there is no way
 * to disagree about one.
 */

/** The kinds of thing that can be recorded, and where each lives. */
export const TOPICS = {
  fact: {
    prefix: FACTS_PREFIX,
    extension: ".md",
    dated: false,
    description:
      "something true about the user — identity, work, home, preferences",
  },
  inventory: {
    prefix: FACTS_PREFIX,
    extension: ".yaml",
    dated: false,
    description: "a list of owned things, as YAML entries",
  },
  todo: {
    prefix: TODOS_PREFIX,
    extension: ".md",
    dated: true,
    description:
      "a task to be done, filed under work/todos/open — it moves to "
      + "work/todos/resolved when finished",
  },
  proposal: {
    prefix: PROPOSALS_PREFIX,
    extension: ".md",
    dated: true,
    description:
      "something suggested but not decided — the user rules on it, and it "
      + "moves to work/proposals/resolved either way, or on to "
      + "work/todos/open if it becomes a task",
  },
  idea: {
    prefix: IDEAS_PREFIX,
    extension: ".md",
    dated: true,
    description:
      "a thought worth keeping that is not yet a proposal and may never be",
  },
  mistake: {
    prefix: MISTAKES_PREFIX,
    extension: ".md",
    dated: true,
    description:
      "something an agent got wrong: what was claimed, what was wrong with "
      + "it, who caught it, and the pattern it belongs to",
  },
  decision: {
    prefix: DECISIONS_PREFIX,
    extension: ".md",
    dated: true,
    description:
      "a decision and its reasoning, as its own dated file — what was "
      + "chosen, what was rejected, and why",
  },
  capture_rule: {
    prefix: CAPTURE_RULES_PREFIX,
    extension: ".md",
    dated: false,
    description:
      "a rule about how an agent should behave, stated explicitly by the "
      + "user — never inferred from how a conversation went",
  },
  infrastructure: {
    prefix: INFRASTRUCTURE_PREFIX,
    extension: ".md",
    dated: false,
    description:
      "machines and services rather than people: how a deployment, domain, "
      + "server or account is set up",
  },
} as const;

export type Topic = keyof typeof TOPICS;

export function topicNames(): Topic[] {
  return Object.keys(TOPICS) as Topic[];
}

/** One line per topic, for tool descriptions. */
export function describeTopics(): string {
  return topicNames()
    .map((name) => `${name} (${TOPICS[name].description})`)
    .join("; ");
}

/**
 * Turn a free-text subject into the file-name part of a path.
 *
 * Lowercase, snake_case, no leading or trailing separators. Slashes are
 * preserved so a caller can say "home/kitchen" and get a subfolder, which is
 * how a topic that outgrows one file splits without needing a second tool.
 */
export function subjectToSlug(subject: string): string {
  const cleaned = subject
    .toLowerCase()
    .split("/")
    .map((segment) =>
      segment
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, ""),
    )
    .filter((segment) => segment.length > 0)
    .join("/");

  if (cleaned.length === 0) {
    throw new Error(
      "That subject has no usable characters. Give something like "
        + '"kitchen appliances" or "home/kitchen".',
    );
  }
  return cleaned;
}

/** ISO date, hyphens intact — the only place hyphens are allowed in a name. */
function isoDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * The full path for a new file. The caller has no say in it beyond the topic
 * and the subject.
 */
export function pathForTopic(
  topic: Topic,
  subject: string,
  now: number,
): string {
  const config = TOPICS[topic];
  const slug = subjectToSlug(subject);

  // The limit applies to the filename, not to the path. A subject with
  // slashes becomes directories, and those are not part of the name that has
  // to fit.
  if (config.dated) {
    // Date first so a directory listing sorts chronologically. The date keeps
    // its hyphens; everything after the separator is snake_case.
    const directory = slug.includes("/")
      ? `${slug.slice(0, slug.lastIndexOf("/") + 1)}`
      : "";
    const name = slug.slice(slug.lastIndexOf("/") + 1);
    const filename = `${isoDate(now)}_${name}${config.extension}`;
    assertFilenameFits(filename, `A subject of "${subject}"`);
    return `${config.prefix}${directory}${filename}`;
  }

  const directory = slug.includes("/")
    ? slug.slice(0, slug.lastIndexOf("/") + 1)
    : "";
  const filename = `${slug.slice(slug.lastIndexOf("/") + 1)}${config.extension}`;
  assertFilenameFits(filename, `A subject of "${subject}"`);
  return `${config.prefix}${directory}${filename}`;
}

/** Where a decision is appended. One file per year, created on demand. */
export function decisionLogPath(now: number): string {
  return `${DECISIONS_PREFIX}${new Date(now).getUTCFullYear()}.md`;
}
