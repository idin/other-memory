import { describe, expect, test } from "vitest";

import { checkStore } from "../src/store_checks";
import { storeFile } from "./chunk_fixture";

/**
 * Checks for the rule Idin set on 2026-08-14: every entry names its own
 * subject, and first or second person is followed by who is meant.
 *
 * The reason it matters is not tidiness. Semantic search represents an entry
 * by the words it contains, so "It moved to TD Bank" produces a
 * representation with no mortgage in it — sitting among unrelated things that
 * also describe something unnamed moving somewhere. Fetching the neighbouring
 * entry afterwards cannot fix that, because the representation was already
 * computed.
 */

function findings(text: string, kind: string, path = "other-memory/facts/x.md") {
  return checkStore([storeFile(path, `# Title\n\nPreamble.\n\n${text}\n`)])
    .filter((finding) => finding.kind === kind)
    .map((finding) => finding.detail);
}

function subjects(text: string, path?: string) {
  return findings(text, "entry_without_a_subject", path);
}

function people(text: string, path?: string) {
  return findings(text, "unnamed_person", path);
}

describe("entries that name nothing", () => {
  test.each([
    ["It went from Scotia to TD Bank."],
    ["They compose rather than compete."],
    ["Both are manual, so he bought a lifter."],
    ["This is a project, not a task."],
    ["The above supersedes the note below."],
    ["- This contradicts two standing rules."],
    ["**They compose rather than compete.** Tokenize first."],
  ])("%s is reported", (text) => {
    expect(subjects(text)).toHaveLength(1);
  });

  test("the finding says which word and which line", () => {
    const [detail] = subjects("It went from Scotia to TD Bank.");
    expect(detail).toContain('"It"');
    expect(detail).toContain("Line 5");
  });
});

describe("entries that do name their subject", () => {
  test.each([
    ["The mortgage moved from Scotia Bank to TD Bank."],
    ["Both turntables are manual, so he bought a lifter."],
    ["Both idin.ca and ixmachina.ai route mail correctly."],
    ["This rule explicitly includes the server itself."],
    ["Frodo is a toy poodle, born 2013-05-06."],
  ])("%s is not reported", (text) => {
    expect(subjects(text)).toEqual([]);
  });

  test("a pronoun later in an entry is fine", () => {
    // The rule is about how an entry opens. Banning pronouns outright would
    // bury the real findings under ordinary prose.
    expect(
      subjects("The mortgage was refinanced in 2020, and it moved to TD Bank."),
    ).toEqual([]);
  });
});

describe("what this check knowingly misses", () => {
  test('"These go into Namecheap" is not caught', () => {
    // Recorded rather than hidden. Telling "These go" from "These records"
    // needs to know whether the next word is a verb or a noun, which needs
    // part-of-speech tagging this does not have. The approximation is a list
    // of common following verbs, and "go" is not on it.
    //
    // The bias is deliberate: a missed finding costs one unnamed subject,
    // while a false one fires on correct writing, and a check that cries wolf
    // gets ignored wholesale.
    expect(subjects("These go into Namecheap's Custom DNS field.")).toEqual([]);
  });
});

describe("first and second person", () => {
  test("an unattributed I is reported", () => {
    // Several agents write here, so "I" in a file Ada wrote and "I" in a file
    // Kip wrote are different people, and nothing in the text says which.
    expect(people("An age I worked backwards from.")).toHaveLength(1);
  });

  test("naming who is meant satisfies it", () => {
    expect(people("I, Idin, decided to move DNS to Cloudflare.")).toEqual([]);
    expect(people("You, Ada, should check the terms first.")).toEqual([]);
  });

  test("quoted speech is exempt", () => {
    // A mistake entry records what Idin actually said. Rewriting the
    // quotation to name him would falsify the record to satisfy a style rule.
    expect(
      people('Caught by Idin: "I didn\'t say rule-name, I said skill".'),
    ).toEqual([]);
  });

  test("a quotation spanning lines is still exempt", () => {
    // Found against the real store: a wrapped quote leaves an unbalanced
    // fragment on each line, and a per-line check sees neither half as quoted.
    expect(
      people(
        'Caught by Idin: "WHY ON EARTH would\nI prefer to hide some of them?"',
      ),
    ).toEqual([]);
  });

  test("third person needs no attribution", () => {
    expect(people("Idin decided to move DNS to Cloudflare.")).toEqual([]);
  });
});

describe("records of what happened are exempt", () => {
  test.each([
    ["other-memory/past/2026-08-12_something_finished.md"],
    ["other-memory/messages/archive/kip/2026-08-09T00-00_ada_note.md"],
  ])("%s is not reported", (path) => {
    // Editing a resolved todo or an acted-on message to satisfy a style rule
    // would rewrite history to look as though the rule had always been
    // followed — the opposite of what a record is for, and the same reasoning
    // as superseded_not_deleted.md.
    expect(subjects("It was the clearest example of the problem.", path))
      .toEqual([]);
  });

  test("but live files are not exempt", () => {
    expect(
      subjects(
        "It was the clearest example.",
        "other-memory/future/todos/2026-08-14_do_something.md",
      ),
    ).toHaveLength(1);
  });
});
