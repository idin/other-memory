import { describe, expect, test } from "vitest";

import { HIDDEN_FROM_AGENTS_PREFIX, isHiddenFromAgents } from "../src/layout";

describe("isHiddenFromAgents", () => {
  test("true for anything under the hidden prefix", () => {
    expect(isHiddenFromAgents(`${HIDDEN_FROM_AGENTS_PREFIX}agent_name_tokens.md`)).toBe(
      true,
    );
    expect(isHiddenFromAgents(`${HIDDEN_FROM_AGENTS_PREFIX}nested/file.md`)).toBe(
      true,
    );
  });

  test("false for paths elsewhere in the namespace", () => {
    expect(isHiddenFromAgents("other-memory/facts/core.md")).toBe(false);
    expect(isHiddenFromAgents("other-memory/instructions/README.md")).toBe(false);
  });

  test("false for paths outside the namespace entirely", () => {
    expect(isHiddenFromAgents("README.md")).toBe(false);
  });

  // The one thing every caller in memory_tree.ts, memory_repo.ts and
  // store_read.ts depends on: a path that merely starts with the same
  // characters as the prefix, without the trailing slash, is not a match —
  // otherwise "other-memory/hidden_from_agents_lookalike.md" would be
  // wrongly hidden too.
  test("a path that only shares a prefix of characters does not match", () => {
    expect(isHiddenFromAgents("other-memory/hidden_from_agents_lookalike.md")).toBe(
      false,
    );
  });
});
