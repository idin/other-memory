/**
 * Where this server is allowed to write, inside whatever repo it is given.
 *
 * Everything lives under a single namespace directory so the server can be
 * pointed at a repo that already has other things in it. It claims
 * `other-memory/` and nothing else — not the repo root, not any sibling
 * directory — which means a second tool could claim its own top-level
 * directory in the same repo without the two colliding.
 *
 * This is the one place the layout is defined. Everything else derives from
 * it.
 */

/** Root of everything this server owns. Nothing outside is ever written. */
export const NAMESPACE = "other-memory/";

/** Append-only log, one file per year. */
export const DECISIONS_PREFIX = `${NAMESPACE}decisions/`;

/** Messages between agents: `messages/inbox/<name>/` and `messages/archive/<name>/`. */
export const MESSAGES_PREFIX = `${NAMESPACE}messages/`;
export const INBOX_PREFIX = `${MESSAGES_PREFIX}inbox/`;
export const ARCHIVE_PREFIX = `${MESSAGES_PREFIX}archive/`;

/** Facts about the user. The part that is actually "memory". */
export const FACTS_PREFIX = `${NAMESPACE}facts/`;

/**
 * Work not yet done, and thinking not yet acted on.
 *
 * Sitting in the folder is what "open" means, so there is no `open/` level
 * inside it. An item leaves when it resolves.
 */
export const FUTURE_PREFIX = `${NAMESPACE}future/`;
export const PROPOSALS_PREFIX = `${FUTURE_PREFIX}proposals/`;
export const IDEAS_PREFIX = `${FUTURE_PREFIX}ideas/`;
export const TODOS_PREFIX = `${FUTURE_PREFIX}todos/`;

/**
 * What `future/` held once it resolved.
 *
 * The temporal sibling of `future/`, which is why it is not called `done/`:
 * a decided proposal, an acted-on idea and a finished todo are all equally
 * past, and only one of the three is "done" in any natural sense.
 */
export const PAST_PREFIX = `${NAMESPACE}past/`;

/**
 * Where an agent's mistakes are recorded, one file per entry.
 *
 * The mirror of `decisions/`. That logs what was chosen and why; this logs
 * what was wrong and why, so the pattern can be seen across entries rather
 * than re-derived each time.
 */
export const MISTAKES_PREFIX = `${NAMESPACE}mistakes/`;

/**
 * Mutable rules the assistant has learned about what to capture, one file per
 * rule. A folder rather than a file since 2026-08-13: rules are organised, not
 * accumulated in one growing document.
 */
export const CAPTURE_RULES_PREFIX = `${NAMESPACE}capture_rules/`;

/**
 * Readable so the assistant can follow the rules; never writable by it.
 *
 * A prefix rather than a single path, and the distinction is the whole point.
 * This was one file guarded by an equality check. Splitting it into a folder
 * without widening the guard would have left every rule file writable — the
 * protection would have been removed by the act of tidying, silently, while
 * the rule text saying it must not be still sat inside the folder.
 *
 * Anything under this prefix is readable and never writable, whatever it is
 * called and however deeply it nests.
 */
export const INSTRUCTIONS_PREFIX = `${NAMESPACE}instructions/`;

/**
 * Where agent-name-verification data lives. Never readable and never
 * writable by any agent-facing tool, whatever it is called and however
 * deeply it nests — the mirror image of `INSTRUCTIONS_PREFIX`, which is
 * readable but never writable. This prefix is neither.
 */
export const HIDDEN_FROM_AGENTS_PREFIX = `${NAMESPACE}hidden_from_agents/`;

/** Decision log filenames are per-year: `decisions/2026.md`. */
export const DECISION_LOG_PATTERN = new RegExp(
  `^${DECISIONS_PREFIX.replace(/\//g, "\\/")}\\d{4}\\.md$`,
);

/** Extensions permitted for files the assistant creates. */
export const ALLOWED_EXTENSIONS = [".md", ".yaml"] as const;

/**
 * Shape check applied to every path before anything else: no traversal, no
 * absolute paths, no dot segments, no doubled slashes.
 *
 * Kept separate from the permission checks because a malformed path should be
 * rejected the same way whatever is being attempted with it.
 */
export function assertWellFormed(path: string): void {
  if (path !== path.trim() || path.length === 0) {
    throw new Error("Path must not be empty or padded with whitespace.");
  }
  if (path.startsWith("/") || path.includes("//")) {
    throw new Error(`Path must be repo-relative: ${path}`);
  }
  if (path.split("/").some((part) => part === ".." || part.startsWith("."))) {
    throw new Error(`Path must not contain traversal or dot segments: ${path}`);
  }
}

/** True when a path sits inside the namespace this server owns. */
export function isWithinNamespace(path: string): boolean {
  return path.startsWith(NAMESPACE);
}

/**
 * True when a path falls under the prefix no agent-facing tool may ever
 * read or write. Checked wherever a path is validated for either
 * direction, unlike `INSTRUCTIONS_PREFIX`, which only needs checking on
 * the write side because reading it is intended.
 */
export function isHiddenFromAgents(path: string): boolean {
  return path.startsWith(HIDDEN_FROM_AGENTS_PREFIX);
}

/** Human-readable summary of the layout, used in tool descriptions. */
export function describeLayout(): string {
  return (
    `${FACTS_PREFIX}<topic>.md for facts, `
    + `${DECISIONS_PREFIX}<year>.md for decisions, `
    + `${MISTAKES_PREFIX}<entry>.md for things an agent got wrong, `
    + `${FUTURE_PREFIX}{todos,proposals,ideas}/ for work and thinking not yet `
    + `resolved, ${PAST_PREFIX} for what resolved, `
    + `${CAPTURE_RULES_PREFIX}<rule>.md for capture rules`
  );
}
