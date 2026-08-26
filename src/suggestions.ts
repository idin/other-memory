/**
 * Gathering evidence for suggested improvements.
 *
 * Idin invokes it; the agent surveys and proposes; Idin decides. The same
 * division as the digest, and for the same reason: a proposal about tools or
 * rules is an agent proposing changes to its own constraints, and the guard
 * against that is separating proposal from adoption rather than trusting the
 * proposal to be disinterested.
 *
 * Nothing here writes. It reads the store, runs the mechanical checks, and
 * returns findings with the rules a proposal must follow. The proposal itself
 * is one file in `future/proposals/`, written by the ordinary create tool with
 * its ordinary guards — this tool never reaches a destructive operation, never
 * calls one, and has no flag that executes what it suggests.
 */

import { checkStore, type StoreFile, type StoreFinding } from "./store_checks";

/** Which of the three areas to survey. */
export type SuggestionArea = "content" | "tools" | "rules";

export type SuggestionMaterial = {
  area: SuggestionArea;
  findings: StoreFinding[];
  instructions: string;
};

/**
 * What a proposal must do, stated at the moment of proposing.
 *
 * In the tool response rather than in prose somewhere, on the same reasoning
 * as every other tier-3 rule: a rule that arrives with the work has a chance
 * that the same rule read at session start does not.
 */
const SUGGESTION_INSTRUCTIONS = `
You are proposing improvements. You are not making them. Write one file in
future/proposals/ with create_memory_file and change nothing else — no
deletions, no edits, no moves. Idin decides what is adopted.

**Say which way each suggestion points.** Every one states whether it WIDENS or
NARROWS what an agent may do. Widening: a new capability, a looser rule,
broader access, a removed check. Narrowing: a validator, a guard, a removed
manual path.

This is not a prohibition, it is a label. An agent recommending wider access
on the grounds that the access would keep it better informed has happened
here before, and reads as advice unless the direction is stated in a word at
the point of deciding.

**Compression must be itemised.** Never "compress the home files". Name the
specific sentences and fields that would be lost. Summarising instead of
storing is degradation, and approving an unspecified compression is the same
failure wearing a permission slip.

**Deletion is only for what was never true.** Idin's ruling, 2026-08-13. A
fact that stopped being true is struck through and kept, because the history
of a fact is usually the useful part. A wrong inference, a misfiling, a
duplicate — those have no history worth keeping and may be proposed for
deletion. Say which of the two any deletion is.

**Findings are evidence, not conclusions.** A mechanical check flags a
candidate. Whether "13 years old" is a stored age or a quotation is your
judgement, and a proposal that repeats the finding without exercising it has
done nothing useful.

**Propose less than you find.** A list of everything detectable is not a
proposal, it is a scan. Say which few things are worth doing and why the rest
are not.
`.trim();

/**
 * Survey the content of the store.
 *
 * @param files - Every file in the namespace, with its text.
 * @returns Findings and the rules a proposal must follow.
 */
export function surveyContent(files: StoreFile[]): SuggestionMaterial {
  return {
    area: "content",
    findings: checkStore(files),
    instructions: SUGGESTION_INSTRUCTIONS,
  };
}

/**
 * Turn recorded tool failures into findings.
 *
 * The cheapest of the three areas to ground, and the only one needing no new
 * instrumentation: the failures are already recorded and nothing reads them.
 * A tool failing repeatedly on the same shape of input is a design defect with
 * a server-side record already sitting there.
 *
 * @param failures - Recorded failures, most recent first.
 * @returns Findings, one per tool that failed more than once.
 */
export function surveyToolFailures(
  failures: Array<{ tool: string; message: string }>,
): SuggestionMaterial {
  const byTool = new Map<string, string[]>();
  for (const failure of failures) {
    byTool.set(failure.tool, [...(byTool.get(failure.tool) ?? []), failure.message]);
  }

  const findings: StoreFinding[] = [];
  for (const [tool, messages] of byTool) {
    if (messages.length < 2) {
      continue;
    }
    const distinct = new Set(messages);
    findings.push({
      kind: distinct.size === 1 ? "tool_fails_the_same_way" : "tool_fails_often",
      path: tool,
      detail:
        distinct.size === 1
          ? `Failed ${messages.length} times with the same message: `
            + `"${messages[0]}". A tool that fails identically more than once `
            + "is usually a design problem rather than bad luck."
          : `Failed ${messages.length} times across ${distinct.size} distinct `
            + "messages. Worth reading before concluding anything.",
    });
  }

  return { area: "tools", findings, instructions: SUGGESTION_INSTRUCTIONS };
}

/**
 * Turn the mistake log into findings about the rules.
 *
 * The signal worth finding is recurrence: a pattern appearing after a rule was
 * written to prevent it means that rule failed. That is more valuable than any
 * number of fresh observations, and it is easy to miss because the entry
 * describing a recurrence reads like every other entry.
 *
 * @param entries - Mistake entries, with their text.
 * @returns Findings about rules that may not be working.
 */
export function surveyRules(
  entries: Array<{ path: string; text: string }>,
): SuggestionMaterial {
  const findings: StoreFinding[] = [];

  const digested = entries.filter((entry) => entry.text.includes("Digested "));
  const recurrences = entries.filter((entry) =>
    /\bagain\b|\brecurr|\bsecond time\b|\bas before\b/i.test(entry.text),
  );

  for (const entry of recurrences) {
    findings.push({
      kind: "pattern_recurred",
      path: entry.path,
      detail:
        "Reads as a repeat of something already recorded. If a rule was "
        + "written to prevent it, that rule failed, and another paragraph "
        + "saying the same thing will fail the same way. Look for a stronger "
        + "tier: a validator, or a rule delivered in the tool response.",
    });
  }

  const caughtByIdin = entries.filter((entry) =>
    /caught by[:\s]+idin/i.test(entry.text),
  );
  if (caughtByIdin.length > 0 && entries.length > 0) {
    const share = Math.round((caughtByIdin.length / entries.length) * 100);
    if (share >= 60) {
      findings.push({
        kind: "log_measures_what_idin_found",
        path: "mistakes/",
        detail:
          `${share}% of entries say Idin caught it. A self-reported log `
          + "under-reports, and a log that mostly records what one person "
          + "noticed is measuring his attention rather than the error rate.",
      });
    }
  }

  if (digested.length === 0 && entries.length >= 5) {
    findings.push({
      kind: "nothing_digested_yet",
      path: "mistakes/",
      detail:
        `${entries.length} entries and none marked digested. Until a digest `
        + "runs, this is a record of failure rather than a loop that changes "
        + "anything.",
    });
  }

  return { area: "rules", findings, instructions: SUGGESTION_INSTRUCTIONS };
}

/**
 * Render findings for a tool response.
 *
 * @param material - What a survey produced.
 * @returns Text for the agent to work from.
 */
export function describeSuggestionMaterial(
  material: SuggestionMaterial,
): string {
  if (material.findings.length === 0) {
    return (
      `${material.instructions}\n\n`
      + `## Nothing found in ${material.area}\n\n`
      + "The mechanical checks found nothing. That is a real answer — "
      + "proposing something anyway would be inventing work."
    );
  }

  const grouped = new Map<string, StoreFinding[]>();
  for (const finding of material.findings) {
    grouped.set(finding.kind, [...(grouped.get(finding.kind) ?? []), finding]);
  }

  const sections = [...grouped].map(([kind, findings]) => {
    const lines = findings.map((f) => `- ${f.path}: ${f.detail}`).join("\n");
    return `### ${kind} (${findings.length})\n\n${lines}`;
  });

  return (
    `${material.instructions}\n\n`
    + `## ${material.findings.length} findings in ${material.area}\n\n`
    + sections.join("\n\n")
  );
}
