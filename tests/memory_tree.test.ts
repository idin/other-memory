import { describe, expect, test } from "vitest";

import { assertManagedPath } from "../src/memory_tree";

/**
 * assertManagedPath is the boundary that keeps structural changes inside the
 * namespace. Everything else in memory_tree.ts calls the GitHub API, so it is
 * covered by the integration path rather than here.
 *
 * The token this server holds can write anywhere in the repo, so these checks
 * are the only thing stopping it. The repo may hold code, notes, anything —
 * none of it is this server's business.
 */

describe("assertManagedPath accepts paths inside the namespace", () => {
  test.each([
    "other-memory/facts/core.md",
    "other-memory/facts/inventory.yaml",
    "other-memory/facts/preferences/food.yaml",
    "other-memory/facts/home/kitchen.md",
    "other-memory/guidance/decisions/2026.md",
    "other-memory/guidance/capture_rules/what_to_capture.md",
    "other-memory/a/b/c/deep.md",
  ])("%s", (path) => {
    expect(() => assertManagedPath(path)).not.toThrow();
  });
});

describe("assertManagedPath rejects paths outside the namespace", () => {
  test.each([
    ["repo root", "README.md"],
    ["another root file", "package.json"],
    ["the old top-level layout", "memory/core.md"],
    ["a sibling namespace", "ix/drive/cache.md"],
    ["the namespace parent", "ix/notes.md"],
    ["source code", "src/index.ts"],
    ["someone else's directory", "docs/guide.md"],
  ])("%s: %s", (_name, path) => {
    expect(() => assertManagedPath(path)).toThrow();
  });
});

describe("assertManagedPath rejects traversal and escapes", () => {
  test.each([
    ["parent traversal", "../secrets.md"],
    ["traversal after prefix", "other-memory/../../README.md"],
    ["double traversal", "other-memory/../../../escape.md"],
    ["nested traversal", "other-memory/sub/../../../package.json"],
    ["absolute path", "/etc/passwd"],
    ["absolute repo path", "/other-memory/core.md"],
    ["double slash", "other-memory//core.md"],
  ])("%s: %s", (_name, path) => {
    expect(() => assertManagedPath(path)).toThrow();
  });
});

describe("assertManagedPath rejects malformed paths", () => {
  test.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["leading space", " other-memory/core.md"],
    ["trailing space", "other-memory/core.md "],
    ["hidden file", "other-memory/.hidden.md"],
    ["hidden directory", "other-memory/.git/config.md"],
    ["folder rather than file", "other-memory/facts/"],
  ])("%s: %s", (_name, path) => {
    expect(() => assertManagedPath(path)).toThrow();
  });
});

describe("assertManagedPath rejects unexpected extensions", () => {
  test.each([
    ["plain text", "other-memory/facts/notes.txt"],
    ["json", "other-memory/facts/data.json"],
    ["executable", "other-memory/facts/script.sh"],
    ["no extension", "other-memory/facts/notes"],
    ["extension in the middle", "other-memory/facts/notes.md.txt"],
  ])("%s: %s", (_name, path) => {
    expect(() => assertManagedPath(path)).toThrow();
  });
});

describe("assertManagedPath protects every instruction, not one file", () => {
  // A folder of rules is only protected if the guard covers the folder. An
  // equality check on one filename would leave the rest creatable, movable and
  // deletable.
  test.each([
    "other-memory/guidance/instructions/superseded_not_deleted.md",
    "other-memory/guidance/instructions/security_posture.md",
    "other-memory/guidance/instructions/README.md",
  ])("%s", (path) => {
    expect(() => assertManagedPath(path)).toThrow(/must not be moved or deleted/);
  });
});

describe("assertManagedPath protects hidden_from_agents from every agent-facing tool", () => {
  test.each([
    "other-memory/hidden_from_agents/agent_name_tokens.md",
    "other-memory/hidden_from_agents/anything_else.md",
  ])("%s", (path) => {
    expect(() => assertManagedPath(path)).toThrow(/not visible to any agent-facing tool/);
  });
});

describe("assertManagedPath error messages", () => {
  test("names the namespace when the path is outside it", () => {
    expect(() => assertManagedPath("README.md")).toThrow(/other-memory\//);
  });

  test("explains that folders are implicit", () => {
    expect(() => assertManagedPath("other-memory/facts/")).toThrow(
      /created implicitly/,
    );
  });
});
