import { describe, expect, test } from "vitest";

import { checkStore, type StoreFile } from "../src/store_checks";
import { surveyRules, surveyToolFailures } from "../src/suggestions";

/**
 * The checks produce evidence, not verdicts. What matters is that they find
 * the things a person would have to read every file to notice, and that they
 * do not flag the files whose job is to describe the very problems they look
 * for.
 */

function file(path: string, text: string): StoreFile {
  return { path, text, bytes: text.length };
}

describe("checkStore finds what a rule already forbids", () => {
  test("a file past the line limit", () => {
    const findings = checkStore([
      file("other-memory/facts/long.md", "line\n".repeat(150)),
    ]);
    expect(findings.some((f) => f.kind === "over_the_line_limit")).toBe(true);
  });

  test("a file under the limit is left alone", () => {
    const findings = checkStore([
      file("other-memory/facts/short.md", "line\n".repeat(10)),
    ]);
    expect(findings.some((f) => f.kind === "over_the_line_limit")).toBe(false);
  });

  test("a bare bank abbreviation", () => {
    const findings = checkStore([
      file("other-memory/facts/money.md", "Refinanced with TD in 2020."),
    ]);
    expect(findings.some((f) => f.kind === "bare_bank_name")).toBe(true);
  });

  test("the same abbreviation followed by Bank is fine", () => {
    const findings = checkStore([
      file("other-memory/facts/money.md", "Refinanced with TD Bank in 2020."),
    ]);
    expect(findings.some((f) => f.kind === "bare_bank_name")).toBe(false);
  });

  test("a rejected abbreviation", () => {
    const findings = checkStore([
      file("other-memory/facts/work.md", "Needs doing ASAP."),
    ]);
    expect(findings.some((f) => f.kind === "rejected_abbreviation")).toBe(true);
  });

  test("a stored age, which will be wrong within a year", () => {
    const findings = checkStore([
      file("other-memory/facts/dog.md", "Frodo is 13 years old."),
    ]);
    expect(findings.some((f) => f.kind === "possible_derived_value")).toBe(true);
  });

  test("a stored elapsed time", () => {
    const findings = checkStore([
      file("other-memory/facts/core.md", "Moved here 3 years ago."),
    ]);
    expect(findings.some((f) => f.kind === "possible_derived_value")).toBe(true);
  });

  test("a birth date is not flagged", () => {
    // The rule says store the date. Flagging the correct form would train
    // whoever reads these findings to ignore them.
    const findings = checkStore([
      file("other-memory/facts/dog.md", "Frodo, born 2013-05-06."),
    ]);
    expect(findings.some((f) => f.kind === "possible_derived_value")).toBe(false);
  });

  test("the rules themselves are not flagged for naming what they forbid", () => {
    // The rule listing rejected words has to list them. A check that flagged
    // it would report the rule as a violation of itself.
    const findings = checkStore([
      file(
        "other-memory/guidance/instructions/abbreviations_are_avoided.md",
        "Rejected outright: ASAP, FYI, TBD. TD, RBC and BMO need Bank after them.",
      ),
    ]);
    expect(findings).toHaveLength(0);
  });

  test("a todo discussing the rules is not flagged either", () => {
    // Run against the real store, half the abbreviation findings were files
    // of this kind — including the todo that asked for the check. Findings
    // that are obviously wrong train whoever reads them to skip the rest.
    const findings = checkStore([
      file(
        "other-memory/work/todos/open/2026-08-12_check_abbreviations.md",
        "Whitelist violations to detect: bare TD, RBC, BMO.",
      ),
    ]);
    expect(findings).toHaveLength(0);
  });

  test("a fact using a bare bank name is still flagged", () => {
    // The exemption must not swallow the real violations it sits beside.
    const findings = checkStore([
      file("other-memory/facts/home/455_beach.md", "Mortgage held with TD since 2019."),
    ]);
    expect(findings.some((f) => f.kind === "bare_bank_name")).toBe(true);
  });
});

describe("surveyToolFailures", () => {
  test("a tool failing the same way twice is a design problem", () => {
    const material = surveyToolFailures([
      { tool: "append_memory", message: "404 not found" },
      { tool: "append_memory", message: "404 not found" },
    ]);
    expect(material.findings[0].kind).toBe("tool_fails_the_same_way");
  });

  test("a single failure is not a pattern", () => {
    const material = surveyToolFailures([
      { tool: "append_memory", message: "404 not found" },
    ]);
    expect(material.findings).toHaveLength(0);
  });

  test("varied failures are reported differently from identical ones", () => {
    const material = surveyToolFailures([
      { tool: "read_memory", message: "404" },
      { tool: "read_memory", message: "409 conflict" },
    ]);
    expect(material.findings[0].kind).toBe("tool_fails_often");
  });
});

describe("surveyRules reads the mistake log", () => {
  test("an entry that reads as a repeat is the signal worth finding", () => {
    // A pattern recurring after a rule was written to prevent it means the
    // rule failed. More valuable than any number of fresh observations.
    const material = surveyRules([
      { path: "mistakes/a.md", text: "Under-counted its own errors, again." },
    ]);
    expect(material.findings.some((f) => f.kind === "pattern_recurred")).toBe(true);
  });

  test("a log nobody has digested is worth saying so", () => {
    const entries = Array.from({ length: 6 }, (_, index) => ({
      path: `mistakes/${index}.md`,
      text: "Something went wrong.",
    }));
    const material = surveyRules(entries);
    expect(material.findings.some((f) => f.kind === "nothing_digested_yet")).toBe(
      true,
    );
  });

  test("a digested log is not nagged about", () => {
    const entries = Array.from({ length: 6 }, (_, index) => ({
      path: `mistakes/${index}.md`,
      text: "Something went wrong.\nDigested 2026-08-13: no rule emitted.",
    }));
    const material = surveyRules(entries);
    expect(material.findings.some((f) => f.kind === "nothing_digested_yet")).toBe(
      false,
    );
  });

  test("a log that mostly records what one person found says so", () => {
    const entries = Array.from({ length: 5 }, (_, index) => ({
      path: `mistakes/${index}.md`,
      text: "Caught by: Idin",
    }));
    const material = surveyRules(entries);
    expect(
      material.findings.some((f) => f.kind === "log_measures_what_idin_found"),
    ).toBe(true);
  });
});
