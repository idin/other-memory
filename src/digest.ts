/**
 * Digesting mistakes into things that prevent a recurrence.
 *
 * Idin's ruling, 2026-08-12: he decides to run a digest. An agent may suggest
 * running one and may propose what it would produce, but does not run it and
 * does not adopt its own output.
 *
 * That separation is the whole design. An agent digesting its own errors is
 * also choosing which are worth generalising and then authoring the rules that
 * constrain it — the self-authorship problem twice over. Splitting proposal
 * from adoption resolves it without needing a second agent to police the
 * first.
 *
 * So nothing here writes a rule. The tool gathers the undigested entries and
 * returns them with the instructions a digest has to follow; the agent reads
 * them and proposes; Idin rules; and only then does anything change.
 */

import type { MemoryRepoConfig } from "./memory_repo";
import { readAllMistakeEntries } from "./mistake_entries";
import { DIGESTED_MARKER } from "./mistakes";

export type DigestMaterial = {
  entries: Array<{ path: string; text: string }>;
  instructions: string;
};

/**
 * What a digest must do with what it reads.
 *
 * Stated to the agent at the moment of the digest rather than left in prose
 * somewhere, because several entries in this very log are failures of rules
 * that already existed in prose. A rule that arrives with the work has a
 * chance the same rule sitting in a file read at session start does not.
 */
const DIGEST_INSTRUCTIONS = `
You are proposing a digest. You are not performing one — nothing you write
here changes any rule, and Idin decides what, if anything, is adopted.

**Compress. Do not generate.**
Fourteen entries collapsed into roughly five patterns the last time anyone
looked. A digest that emits one rule per entry produces a rule a day and fills
the capture-rules cap within a week. Emitting nothing is a permitted and
sometimes correct outcome. Rule inflation is the failure mode to design
against, not under-production.

**Rank each pattern by how it could be enforced, in this order.**
1. Can a validator refuse it? Code that throws is the only tier an agent
   cannot talk itself past.
2. Can the server say it in a tool response, at the moment of the action?
3. Can a skill description catch it? On chat surfaces this is the only path by
   which a rule reaches an agent at all, since matching against the
   description is the sole mechanism — which makes description wording the
   highest-leverage output available.
4. Only if none of those work: prose.

Prose is the easiest output and the weakest. Several entries here are failures
of rules that were already written in prose, so answering a pattern with
another paragraph is adding more of the thing that already did not work. If
your proposal is prose, say why the three stronger tiers do not apply.

**Name the entries each proposal came from**, by filename. A rule without
provenance cannot later be judged against whether the pattern recurred.

**Say whether each proposal widens or narrows what an agent may do.**

**Look for recurrence before anything else.** A pattern that appears here
after a rule was already written to prevent it means that rule failed. That is
the single most valuable thing in the log and it is easy to miss, because the
entry describing the recurrence reads like any other entry.
`.trim();

/**
 * Gather the undigested entries and the instructions for digesting them.
 *
 * @param config - Where the memory lives.
 * @returns The entries, and what a digest must do with them.
 */
export async function gatherDigestMaterial(
  config: MemoryRepoConfig,
): Promise<DigestMaterial> {
  const entries = (await readAllMistakeEntries(config)).filter(
    (entry) => !entry.text.includes(DIGESTED_MARKER),
  );

  return { entries, instructions: DIGEST_INSTRUCTIONS };
}

/**
 * The note an entry carries once it has been through a digest.
 *
 * Appended rather than replacing anything, so the entry stays readable. An
 * entry that produced nothing still gets marked: otherwise the same entries
 * resurface at every future digest, the count never falls, and a number that
 * only ever grows is a number people stop reading.
 *
 * @param options.date - The digest's date, as `YYYY-MM-DD`.
 * @param options.produced - What came of this entry, or an empty list.
 * @returns Markdown to append to the entry.
 */
export function digestedNote(options: {
  date: string;
  produced: string[];
}): string {
  const { date, produced } = options;
  if (produced.length === 0) {
    return (
      `\n${DIGESTED_MARKER}${date}: no rule emitted. The pattern was too thin `
      + "to generalise, or is already covered. Recorded so this entry is not "
      + "reconsidered at every future digest.\n"
    );
  }
  return (
    `\n${DIGESTED_MARKER}${date}, and contributed to:\n`
    + produced.map((item) => `- ${item}`).join("\n")
    + "\n\nIf this pattern appears again after the above, the above did not "
    + "work. That is worth more than another entry.\n"
  );
}
