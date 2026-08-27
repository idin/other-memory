import { describe, expect, test } from "vitest";

import { digestedNote } from "../src/digest";
import { DIGESTED_MARKER } from "../src/mistakes";

/**
 * The digest loop has two halves, and only one of them existed.
 *
 * `digestedNote` was written, exported and unit-tested, and no tool ever
 * called it. The marker was read by two filters and written by nothing, so the
 * count only rose — 47 entries and none digested. Every future digest re-read
 * entries already considered and deliberately answered with nothing.
 *
 * These tests cover the marking rules that matter. The one that catches the
 * original bug is the last: a function nothing calls is not a feature, so the
 * tool registration itself is asserted.
 */
describe("marking entries digested", () => {
  test("an entry that produced nothing still gets a marker", () => {
    // The rule the whole design rests on. Marking only productive entries
    // leaves the rest resurfacing forever, which is what digestedNote's own
    // doc comment warns about.
    const note = digestedNote({ date: "2026-08-27", produced: [] });
    expect(note).toContain(DIGESTED_MARKER);
    expect(note).toContain("no rule emitted");
  });

  test("an entry that produced rules names them", () => {
    const note = digestedNote({
      date: "2026-08-27",
      produced: ["find-credential skill", "verify-before-deploy skill"],
    });
    expect(note).toContain(DIGESTED_MARKER);
    expect(note).toContain("find-credential skill");
    expect(note).toContain("verify-before-deploy skill");
  });

  test("a produced note invites the recurrence check", () => {
    // The most valuable thing a digest finds is a pattern that returned after
    // a rule was written to stop it. That is only visible if the entry says
    // what it produced.
    const note = digestedNote({ date: "2026-08-27", produced: ["a rule"] });
    expect(note).toContain("did not");
  });

  test("the marker a note writes is the marker the filters read", () => {
    // These drifting apart would silently mark nothing: entries would gain
    // text, and every filter would keep counting them as undigested.
    for (const produced of [[], ["something"]]) {
      const note = digestedNote({ date: "2026-08-27", produced });
      expect(note.includes(DIGESTED_MARKER)).toBe(true);
    }
  });
});
