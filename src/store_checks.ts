/**
 * The checks a machine can make about the state of the store.
 *
 * Most of what makes a store worth cleaning is detectable without judgement:
 * a file past the length at which it should have become a folder, a bare
 * abbreviation the whitelist forbids, a stored age that will be wrong within
 * a year. Running these in code rather than asking an agent to notice them
 * spends the agent's judgement only where judgement is actually required.
 *
 * These findings are evidence for a proposal. None of them is a proposal, and
 * nothing here changes anything.
 */

import { isDeep } from "./deep_memory";
import {
  ALLOWED_EXTENSIONS,
  INSTRUCTIONS_PREFIX,
  MESSAGES_PREFIX,
  NAMESPACE,
} from "./layout";

/** Lines past which the layout rule says a file becomes a subfolder. */
const LINE_LIMIT = 100;

/** Abbreviations that must always be followed by "Bank". */
const BANKS = ["TD", "RBC", "BMO"];

/** Abbreviations rejected outright by the naming rules. */
const REJECTED_ABBREVIATIONS = [
  "ASAP",
  "FYI",
  "TBD",
  "WIP",
  "IMO",
  "AKA",
  "ETA",
  "RL",
];

/**
 * Phrases that usually mean a derived value was stored.
 *
 * Deliberately loose. This produces candidates for an agent to judge, not
 * verdicts — "13 years old" in a fact file is almost certainly a stored age,
 * and the same words inside a quotation are not.
 */
const DERIVED_VALUE_PATTERNS = [
  /\b\d+\s*years?\s+old\b/i,
  /\bage[ds]?\s+\d+\b/i,
  /\b\d+\s*(years?|months?|weeks?)\s+ago\b/i,
  /\bfor\s+the\s+past\s+\d+\s*(years?|months?)\b/i,
];

/**
 * References that name nothing when an entry opens with one.
 *
 * Kept in step with `DANGLING_REFERENCE_PATTERN` in `chunking.ts`, which
 * detects the same thing for a different purpose: that one repairs a retrieved
 * result by fetching the neighbour, this one reports the entry so it can be
 * rewritten. The repair costs context on every search; the rewrite is
 * permanent.
 *
 * Leading markdown emphasis is skipped, since "**They compose**" is the same
 * failure dressed up.
 */
const ENTRY_OPENING_REFERENCE = new RegExp(
  // Always bare: these take no noun after them, so an entry opening with one
  // never names its subject.
  "^[-*\\s]*\\**(It|They|Them|The above|The former|The latter)\\b"
    // Bare only when no noun follows. "Both turntables are manual" names its
    // subject and "Both are manual" does not — the rule is about naming the
    // subject, not about banning the word.
    //
    // Telling those apart properly needs to know whether the next word is a
    // noun or a verb, which needs part-of-speech tagging this does not have.
    // The approximation is a list of common following verbs, so the check
    // MISSES cases whose verb is not listed — "These go into Namecheap"
    // reads as fine to it.
    //
    // Deliberately biased that way. A missed finding costs one unnamed
    // subject; a false one fires on correct writing, and a check that cries
    // wolf gets ignored wholesale — which is how the suggestion tool's first
    // run produced 117 findings nobody could use.
    + "|^[-*\\s]*\\**(This|That|These|Those|Both|Either|Neither|Such)"
    + "(?=\\s+(is|are|was|were|has|have|had|will|would|can|could|should|"
    + "explicitly|also|answers|supersedes|contradicts|means|includes|"
    + "open|of\\b|,|:)|\\s*[.,:;]|$)",
);

/**
 * First and second person, which name nobody.
 *
 * Worse than an ordinary pronoun rather than milder. More than one agent
 * writes to this store, so "I" in a file Ada wrote and "I" in a file Kip wrote
 * are different people and nothing in the text distinguishes them. A retrieved
 * entry cannot recover the referent, and the vector semantic search compares
 * against contains no person at all.
 *
 * Checked anywhere in a line, not only at an entry's opening: unlike "it",
 * which a nearby subject resolves, "I" is never resolved by anything in the
 * text. Permitted when the name follows immediately — "I, Idin, decided" —
 * which is what the negative lookahead allows.
 */
const UNNAMED_PERSON = /\b(I|You)\b(?!\s*,\s*[A-Z])(?!'|\s+(am|are))/;

export type StoreFinding = {
  /** What kind of problem this is, so like ones can be grouped. */
  kind: string;
  path: string;
  detail: string;
};

export type StoreFile = { path: string; text: string; bytes: number };

/**
 * Run every mechanical check over the store.
 *
 * @param files - Every file in the namespace, with its text.
 * @returns One finding per problem, in no particular order.
 */
export function checkStore(files: StoreFile[]): StoreFinding[] {
  return [
    ...tooLong(files),
    ...bareBankNames(files),
    ...rejectedAbbreviations(files),
    ...storedDerivedValues(files),
    ...entriesWithoutASubject(files),
    ...unnamedPeople(files),
  ];
}

/**
 * Whether a file is discussing the rules rather than subject to them.
 *
 * A todo that specifies an abbreviation check has to name the abbreviations.
 * A mistake entry recording a naming error has to quote the error. A
 * decision log records what was decided, in the words it was decided in.
 *
 * Run against the real store, half the abbreviation findings were files of
 * exactly this kind — including the todo that asked for the check. Findings
 * that are obviously wrong are worse than no findings, because they train
 * whoever reads them to skip the rest.
 */
function discussesTheRules(file: StoreFile): boolean {
  if (file.path.startsWith(INSTRUCTIONS_PREFIX)) {
    return true;
  }
  return /naming rule|abbreviation|whitelist|rejected outright/i.test(file.text);
}

/**
 * Whether a file records what happened rather than what is true.
 *
 * Resolved work and acted-on correspondence are kept as they were written.
 * Editing them to satisfy a style rule would rewrite history to look as though
 * the rule had always been followed, which is the opposite of what a record is
 * for — and the same reasoning as `superseded_not_deleted.md`.
 *
 * So a finding against one of these is a finding nobody should act on, and a
 * finding nobody should act on trains its reader to skip the rest.
 */
function isHistoricalRecord(file: StoreFile): boolean {
  // The same set the deep tier uses: every stage's resolved/ plus the message
  // archive. Shared rather than restated, so a new resolved area cannot be
  // added to one list and forgotten in the other.
  return isDeep(file.path);
}

/**
 * Files past the length at which the layout rule says they become a folder.
 *
 * The instructions are exempt. They are read whole rather than looked up, so
 * the rule that motivates splitting does not apply to them — and they were
 * split anyway, on a different argument.
 */
function tooLong(files: StoreFile[]): StoreFinding[] {
  return files
    .filter((file) => !file.path.startsWith(INSTRUCTIONS_PREFIX))
    .map((file) => ({ file, lines: file.text.split("\n").length }))
    .filter(({ lines }) => lines > LINE_LIMIT)
    .map(({ file, lines }) => ({
      kind: "over_the_line_limit",
      path: file.path,
      detail:
        `${lines} lines, over the ${LINE_LIMIT} at which the layout rule says `
        + "a file becomes a subfolder with one entry per file.",
    }));
}

/** TD, RBC and BMO must each be followed by "Bank". */
function bareBankNames(files: StoreFile[]): StoreFinding[] {
  const findings: StoreFinding[] = [];
  for (const file of files) {
    if (discussesTheRules(file)) {
      continue;
    }
    for (const bank of BANKS) {
      // Not followed by "Bank", and not inside a longer word.
      const bare = new RegExp(`\\b${bank}\\b(?!\\s+Bank)`, "g");
      const matches = file.text.match(bare);
      if (matches) {
        findings.push({
          kind: "bare_bank_name",
          path: file.path,
          detail:
            `${bank} appears ${matches.length} time(s) without "Bank" after `
            + "it. The naming rules require it in filenames and in prose.",
        });
      }
    }
  }
  return findings;
}

/** Abbreviations the naming rules reject outright. */
function rejectedAbbreviations(files: StoreFile[]): StoreFinding[] {
  const findings: StoreFinding[] = [];
  for (const file of files) {
    if (discussesTheRules(file)) {
      continue;
    }
    for (const abbreviation of REJECTED_ABBREVIATIONS) {
      if (new RegExp(`\\b${abbreviation}\\b`).test(file.text)) {
        findings.push({
          kind: "rejected_abbreviation",
          path: file.path,
          detail: `Uses ${abbreviation}, which the naming rules reject outright.`,
        });
      }
    }
  }
  return findings;
}

/**
 * Values that look derived, and so will be wrong later.
 *
 * Candidates rather than verdicts: the same words are fine inside a quotation
 * of something somebody said.
 */
function storedDerivedValues(files: StoreFile[]): StoreFinding[] {
  const findings: StoreFinding[] = [];
  for (const file of files) {
    if (file.path.startsWith(INSTRUCTIONS_PREFIX)) {
      continue;
    }
    for (const pattern of DERIVED_VALUE_PATTERNS) {
      const match = file.text.match(pattern);
      if (match) {
        findings.push({
          kind: "possible_derived_value",
          path: file.path,
          detail:
            `Contains "${match[0]}", which reads as a derived value. The `
            + "store-the-fact rule says record the date and compute the rest. "
            + "Check whether this is a stored age or a quotation.",
        });
        break;
      }
    }
  }
  return findings;
}

/**
 * Bullets and paragraphs that open with a reference to something unnamed.
 *
 * An entry beginning "It went from Scotia to TD Bank" only means anything to
 * a reader who has just read the entry above it, and search retrieves an
 * entry rather than a file. Such a fact is in the store and cannot be
 * retrieved, which is indistinguishable from never having recorded it.
 *
 * Only the opening is checked. Pronouns inside an entry that has already named
 * its subject are ordinary prose, and flagging them would bury the real
 * findings.
 */
function entriesWithoutASubject(files: StoreFile[]): StoreFinding[] {
  const findings: StoreFinding[] = [];
  for (const file of files) {
    if (discussesTheRules(file) || isHistoricalRecord(file)) {
      continue;
    }
    const lines = file.text.split("\n");
    lines.forEach((line, index) => {
      const opener = ENTRY_OPENING_REFERENCE.exec(line);
      if (!opener) {
        return;
      }
      // Only an entry's first line counts. A continuation line inside a
      // bullet has its subject a few words earlier, not a chunk away.
      const previous = lines[index - 1] ?? "";
      if (previous.trim().length > 0 && !/^[-*]\s/.test(line)) {
        return;
      }
      findings.push({
        kind: "entry_without_a_subject",
        path: file.path,
        detail:
          `Line ${index + 1} opens with "${opener[1]}", which names nothing. `
          + "Retrieved on its own — and search retrieves entries, not files — "
          + "this says nothing and cannot be found by searching for its "
          + "subject. Name the subject.",
      });
    });
  }
  return findings;
}

/**
 * First or second person without a name attached.
 *
 * Separate from {@link entriesWithoutASubject} because the failure differs: a
 * dangling "it" can be resolved by the entry before it, and "I" cannot be
 * resolved by anything. Several agents write here, so the referent genuinely
 * varies between files.
 */
function unnamedPeople(files: StoreFile[]): StoreFinding[] {
  const findings: StoreFinding[] = [];
  for (const file of files) {
    if (discussesTheRules(file) || file.path.startsWith(MESSAGES_PREFIX)) {
      continue;
    }
    // Quoted speech is exempt, and must be. A mistake entry records what
    // Idin actually said; rewriting the quotation to name him would falsify
    // the record to satisfy a style rule. Against the real store this was
    // five of six findings — a check firing on them would train its reader to
    // ignore the sixth, which is genuine.
    //
    // Quotes are stripped across the whole file rather than line by line,
    // because a quotation that wraps leaves an unbalanced fragment on each of
    // its lines and a per-line strip sees neither half as quoted.
    const withoutQuotes = file.text
      .replace(/"[^"]*"/gs, '""')
      .replace(/“[^”]*”/gs, "“”")
      .replace(/`[^`]*`/gs, "``");
    const lines = withoutQuotes.split("\n");
    lines.forEach((line, index) => {
      const match = UNNAMED_PERSON.exec(line);
      if (!match) {
        return;
      }
      findings.push({
        kind: "unnamed_person",
        path: file.path,
        detail:
          `Line ${index + 1} uses "${match[1]}" without naming who. More than `
          + "one agent writes here, so the referent differs between files and "
          + "nothing in the text says which. Name them, or write it in the "
          + `third person: "${match[1]}, Idin, ..." or "Idin ...".`,
      });
    });
  }
  return findings;
}

/** Extensions the store permits, for a caller checking a proposed path. */
export function permittedExtensions(): readonly string[] {
  return ALLOWED_EXTENSIONS;
}

/** The namespace every finding is relative to. */
export function checkedNamespace(): string {
  return NAMESPACE;
}
