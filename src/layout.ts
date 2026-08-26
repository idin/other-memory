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

/**
 * How an agent should behave, and the record of how that was arrived at.
 *
 * Four things that all govern behaviour rather than describing the world:
 * the rules an agent must follow, the rules it has learned about what to
 * capture, what it got wrong, and what was decided. They sat at the top
 * level next to `facts/` until 2026-08-26, which put a three-file folder of
 * capture rules beside the memory itself and made the top level nine
 * entries deep.
 */
export const GUIDANCE_PREFIX = `${NAMESPACE}guidance/`;

/** One file per decision, dated. */
export const DECISIONS_PREFIX = `${GUIDANCE_PREFIX}decisions/`;

/** Messages between agents: `messages/inbox/<name>/` and `messages/archive/<name>/`. */
export const MESSAGES_PREFIX = `${NAMESPACE}messages/`;
export const INBOX_PREFIX = `${MESSAGES_PREFIX}inbox/`;
export const ARCHIVE_PREFIX = `${MESSAGES_PREFIX}archive/`;

/** Facts about the user. The part that is actually "memory". */
export const FACTS_PREFIX = `${NAMESPACE}facts/`;

/**
 * Work, at whatever stage it has reached.
 *
 * `ideas/`, `proposals/` and `todos/` are stages of one pipeline, not three
 * categories: a thought becomes a proposal, a proposal becomes a task, and
 * any of them can move back. Moving a file between them is how that is
 * recorded.
 *
 * Each stage has its own `open/` and `resolved/`, and both are folders. A
 * file never sits beside a folder holding files of its own kind — a todo
 * next to a directory of todos is two different kinds of thing at one level.
 *
 * A thing resolves in whichever stage it had reached: an idea abandoned as
 * an idea lands in `ideas/resolved/`; an idea promoted to a todo and then
 * finished lands in `todos/resolved/`.
 *
 * Replaced `future/` and `past/` on 2026-08-26. Those split one lifecycle
 * across two trees, and `past/` was flat, so a resolved proposal and a
 * resolved todo became indistinguishable once they got there.
 */
export const WORK_PREFIX = `${NAMESPACE}work/`;

export const IDEAS_PREFIX = `${WORK_PREFIX}ideas/open/`;
export const IDEAS_RESOLVED_PREFIX = `${WORK_PREFIX}ideas/resolved/`;

export const PROPOSALS_PREFIX = `${WORK_PREFIX}proposals/open/`;
export const PROPOSALS_RESOLVED_PREFIX = `${WORK_PREFIX}proposals/resolved/`;

export const TODOS_PREFIX = `${WORK_PREFIX}todos/open/`;
export const TODOS_RESOLVED_PREFIX = `${WORK_PREFIX}todos/resolved/`;

/**
 * Machines and services rather than people: deployment configuration,
 * account identifiers, how a thing is wired up.
 *
 * Real config files live here, not only prose about them, because a
 * `wrangler.jsonc` is the authority on its own deployment and a description
 * of one goes stale the moment the real file changes.
 */
export const INFRASTRUCTURE_PREFIX = `${NAMESPACE}infrastructure/`;

/**
 * Where an agent's mistakes are recorded, one file per entry.
 *
 * The mirror of `decisions/`. That logs what was chosen and why; this logs
 * what was wrong and why, so the pattern can be seen across entries rather
 * than re-derived each time.
 */
export const MISTAKES_PREFIX = `${GUIDANCE_PREFIX}mistakes/`;

/**
 * Mutable rules the assistant has learned about what to capture, one file per
 * rule. A folder rather than a file since 2026-08-13: rules are organised, not
 * accumulated in one growing document.
 */
export const CAPTURE_RULES_PREFIX = `${GUIDANCE_PREFIX}capture_rules/`;

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
export const INSTRUCTIONS_PREFIX = `${GUIDANCE_PREFIX}instructions/`;

/**
 * Where agent-name-verification data lives. Never readable and never
 * writable by any agent-facing tool, whatever it is called and however
 * deeply it nests — the mirror image of `INSTRUCTIONS_PREFIX`, which is
 * readable but never writable. This prefix is neither.
 */
export const HIDDEN_FROM_AGENTS_PREFIX = `${NAMESPACE}hidden_from_agents/`;

/**
 * Decision filenames are dated, one file per decision:
 * `guidance/decisions/2026-08-26_moved_the_deployment_config.md`.
 *
 * Was one file per year (`decisions/2026.md`) until 2026-08-26. A single
 * growing document contradicted the store's own
 * `many_small_files_not_one_document` instruction, and the folder held both
 * shapes at once — a yearly log beside two one-file-per-decision entries.
 */
export const DECISION_LOG_PATTERN = new RegExp(
  `^${DECISIONS_PREFIX.replace(/\//g, "\\/")}\\d{4}-\\d{2}-\\d{2}_[a-z0-9_]+\\.md$`,
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
    + `${WORK_PREFIX}{ideas,proposals,todos}/{open,resolved}/ for work at `
    + `each stage, `
    + `${DECISIONS_PREFIX}<entry>.md for decisions, `
    + `${MISTAKES_PREFIX}<entry>.md for things an agent got wrong, `
    + `${CAPTURE_RULES_PREFIX}<rule>.md for capture rules, `
    + `${INFRASTRUCTURE_PREFIX} for machines and services`
  );
}
