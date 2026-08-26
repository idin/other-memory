/**
 * Rules delivered with the operation they govern.
 *
 * A rule written in prose and read at session start is at the weakest tier
 * available: it competes for attention with everything else loaded that
 * session, and by the time it applies it may be thousands of tokens behind.
 * Several entries in this repository's mistake log are failures of rules
 * that were already written down.
 *
 * A rule attached to a tool response arrives at the only moment it matters, in
 * the context that is definitely present. It does not force compliance —
 * nothing short of removing the alternative does that — but it removes the
 * excuse of not having had the rule to hand.
 *
 * Two things keep this from becoming noise. A reminder fires only where it is
 * genuinely relevant, and it says one thing. A paragraph appended to every
 * response is skimmed past, including on the call where it mattered.
 */

/** A rule, and the moment it should arrive. */
export type ToolReminder = {
  /** The tool whose response carries it. */
  tool: string;
  /**
   * Whether this call is one the rule applies to. Given the tool's arguments,
   * so a reminder can fire on writing a fact but not on writing a todo.
   */
  applies: (args: Record<string, unknown>) => boolean;
  /** The rule itself. One or two sentences. */
  text: string;
};

/**
 * The rules that have no mechanism beneath them.
 *
 * Deliberately short. Every rule in the instructions could be attached to
 * something, and attaching all of them would produce a wall of text on every
 * call that agents learn to ignore — which would cost the ones that matter
 * their only chance of being read.
 *
 * These are here because they govern an agent's handling of its own failures
 * and omissions, which is the worst possible thing to leave depending on that
 * same agent remembering a paragraph.
 */
export const TOOL_REMINDERS: ToolReminder[] = [
  {
    // Capture rule 1. An agent that announces a write and then ends the turn
    // has failed this, and did so on 2026-08-12 while the rule was in force.
    tool: "create_memory_file",
    applies: (args) => args.topic === "todo",
    text:
      "Filed. If anything else came up that cannot be done through this "
      + "server — a rule change, a library change, a migration — file that "
      + "too, now, rather than describing it and moving on. Work announced "
      + "but not filed is the failure this rule exists to catch.",
  },
  {
    tool: "create_memory_file",
    applies: (args) => args.topic === "fact",
    text:
      "Only what the user actually stated. If any part of this was inferred "
      + "rather than said, say so in the file — an inference recorded as a "
      + "fact is indistinguishable from a fact a week later.",
  },
  {
    tool: "append_memory",
    applies: () => true,
    text:
      "Corrections supersede rather than replace: strike the old value "
      + "through with ~~...~~ and date it, so the drift stays visible in the "
      + "file rather than only in the diff.",
  },
  {
    tool: "delete_memory_file",
    applies: () => true,
    text:
      "Only something that was never true should be deleted. Something that "
      + "stopped being true is struck through and kept, because the history "
      + "of a fact is often the useful part.",
  },
];

/**
 * The reminder for a call, if there is one.
 *
 * @param tool - The tool being called.
 * @param args - Its arguments, so relevance can depend on them.
 * @returns The rule to attach, or null when none applies.
 */
export function reminderFor(
  tool: string,
  args: Record<string, unknown>,
): string | null {
  const matched = TOOL_REMINDERS.filter(
    (reminder) => reminder.tool === tool && reminder.applies(args),
  );
  if (matched.length === 0) {
    return null;
  }
  // More than one would be a wall of text, which is the thing this is trying
  // to avoid. The first is the most specific, since the list is ordered that
  // way.
  return matched[0].text;
}

/**
 * Attach a reminder to a tool's response text.
 *
 * @param text - What the tool was going to say.
 * @param reminder - The rule, or null.
 * @returns The response, with the rule set apart from the result so it is not
 *   mistaken for part of the answer.
 */
export function withReminder(text: string, reminder: string | null): string {
  return reminder ? `${text}\n\n${reminder}` : text;
}
