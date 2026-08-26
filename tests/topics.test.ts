import { describe, expect, test } from "vitest";

import {
  TOPICS,
  describeTopics,
  pathForTopic,
  subjectToSlug,
  topicNames,
} from "../src/topics";

/**
 * Paths are derived, never supplied. These tests are what makes that claim
 * true rather than aspirational — if the derivation drifts, the layout drifts
 * with it, and nothing else would notice.
 */

const WHEN = Date.UTC(2026, 7, 9, 12, 0, 0);

describe("subjectToSlug", () => {
  test.each([
    ["kitchen appliances", "kitchen_appliances"],
    ["Kitchen Appliances", "kitchen_appliances"],
    ["  padded  ", "padded"],
    ["Re: it works!!", "re_it_works"],
    // The accent is stripped but the letter survives, so this is cafe not caf.
    ["café notes", "cafe_notes"],
    ["multiple   spaces", "multiple_spaces"],
    ["already_snake", "already_snake"],
    ["hyphen-separated", "hyphen_separated"],
  ])("%s becomes %s", (subject, expected) => {
    expect(subjectToSlug(subject)).toBe(expected);
  });

  test("a slash makes a subfolder", () => {
    expect(subjectToSlug("home/kitchen")).toBe("home/kitchen");
  });

  test("each path segment is cleaned independently", () => {
    expect(subjectToSlug("Home Stuff/Kitchen Appliances")).toBe(
      "home_stuff/kitchen_appliances",
    );
  });

  test("empty segments collapse rather than producing a double slash", () => {
    expect(subjectToSlug("home//kitchen")).toBe("home/kitchen");
    expect(subjectToSlug("/home/kitchen/")).toBe("home/kitchen");
  });

  test("a subject with nothing usable is refused", () => {
    expect(() => subjectToSlug("!!!")).toThrow(/no usable characters/);
    expect(() => subjectToSlug("   ")).toThrow();
  });

  test("slugging itself no longer imposes a length of its own", () => {
    // The limit moved to the finished filename, where the date and extension
    // are also counted. Two derivations each carrying their own number is how
    // they came to disagree.
    expect(subjectToSlug("a".repeat(200))).toHaveLength(200);
  });
});

describe("pathForTopic puts things where they belong", () => {
  test("a fact", () => {
    expect(pathForTopic("fact", "core", WHEN)).toBe("other-memory/facts/core.md");
  });

  test("a fact in a subfolder", () => {
    expect(pathForTopic("fact", "home/kitchen", WHEN)).toBe(
      "other-memory/facts/home/kitchen.md",
    );
  });

  test("an inventory is YAML, not markdown", () => {
    expect(pathForTopic("inventory", "owned things", WHEN)).toBe(
      "other-memory/facts/owned_things.yaml",
    );
  });

  test("a todo is dated and filed under future", () => {
    expect(pathForTopic("todo", "check the lease", WHEN)).toBe(
      "other-memory/work/todos/open/2026-08-09_check_the_lease.md",
    );
  });

  test("a proposal is dated and filed under future", () => {
    expect(pathForTopic("proposal", "move the dns to cloudflare", WHEN)).toBe(
      "other-memory/work/proposals/open/2026-08-09_move_the_dns_to_cloudflare.md",
    );
  });

  test("an idea is dated and filed under future", () => {
    expect(pathForTopic("idea", "a tool that compares things", WHEN)).toBe(
      "other-memory/work/ideas/open/2026-08-09_a_tool_that_compares_things.md",
    );
  });

  test("a mistake is dated and filed on its own", () => {
    // The mirror of decisions/: what was wrong, beside what was chosen.
    expect(pathForTopic("mistake", "asserted a path without checking", WHEN)).toBe(
      "other-memory/guidance/mistakes/2026-08-09_asserted_a_path_without_checking.md",
    );
  });

  test("a decision goes in the decisions folder", () => {
    // Dated since 2026-08-26: one file per decision rather than one per
    // year, so the filename has to distinguish two decisions on one subject.
    expect(pathForTopic("decision", "use postgres", WHEN)).toBe(
      "other-memory/guidance/decisions/2026-08-09_use_postgres.md",
    );
  });
});

describe("derived paths obey the naming rules", () => {
  const subjects = [
    "core",
    "home/kitchen",
    "Kitchen Appliances",
    "re: the thing",
    "a/b/c",
  ];

  test("hyphens appear only inside an ISO date", () => {
    for (const topic of topicNames()) {
      for (const subject of subjects) {
        const path = pathForTopic(topic, subject, WHEN);
        // Strip the namespace prefix and any yyyy-mm-dd, then nothing
        // hyphenated should remain.
        const withoutNamespace = path.replace(/^other-memory\//, "");
        const withoutDates = withoutNamespace.replace(/\d{4}-\d{2}-\d{2}/g, "");
        expect(withoutDates).not.toContain("-");
      }
    }
  });

  test("every path stays inside the namespace", () => {
    for (const topic of topicNames()) {
      for (const subject of subjects) {
        expect(pathForTopic(topic, subject, WHEN)).toMatch(/^other-memory\//);
      }
    }
  });

  test("nothing is uppercase", () => {
    for (const topic of topicNames()) {
      for (const subject of subjects) {
        const path = pathForTopic(topic, subject, WHEN);
        expect(path).toBe(path.toLowerCase());
      }
    }
  });

  test("extensions are only .md or .yaml", () => {
    for (const topic of topicNames()) {
      const path = pathForTopic(topic, "anything", WHEN);
      expect(path).toMatch(/\.(md|yaml)$/);
    }
  });

  test("a subject cannot escape the namespace", () => {
    // Traversal segments are stripped by the slug, not passed through.
    const path = pathForTopic("fact", "../../../etc/passwd", WHEN);
    expect(path).toMatch(/^other-memory\/facts\//);
    expect(path).not.toContain("..");
  });
});

describe("the same input always gives the same path", () => {
  test("repeated calls agree", () => {
    const first = pathForTopic("fact", "kitchen appliances", WHEN);
    const second = pathForTopic("fact", "Kitchen  Appliances", WHEN);
    expect(first).toBe(second);
  });

  test("a todo's date comes from the clock, not the caller", () => {
    const earlier = pathForTopic("todo", "thing", Date.UTC(2025, 0, 15));
    expect(earlier).toContain("2025-01-15_");
  });
});

describe("topic metadata", () => {
  test("every topic is described for the tool listing", () => {
    for (const name of topicNames()) {
      expect(describeTopics()).toContain(name);
      expect(TOPICS[name].description.length).toBeGreaterThan(10);
    }
  });

  test("every topic writes inside the namespace", () => {
    for (const name of topicNames()) {
      expect(TOPICS[name].prefix).toMatch(/^other-memory\//);
    }
  });
});
