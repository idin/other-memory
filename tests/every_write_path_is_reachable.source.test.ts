import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A function nothing calls is not a feature.
 *
 * `digestedNote` was written, exported, and unit-tested. No tool called it, so
 * no entry could ever be marked digested — the marker was read by two filters
 * and written by nothing. The store reached 47 mistakes with 0 digested, and
 * every digest re-read entries already considered and answered with nothing.
 *
 * Unit tests did not catch it, because the function itself was correct. What
 * was missing was the wiring, and wiring is only visible from outside the
 * module. So this checks reachability: every exported capability that is meant
 * to be callable through the server must actually be registered.
 */
describe("write paths are reachable from a tool", () => {
  const index = readFileSync(
    join(import.meta.dirname, "..", "src", "index.ts"),
    "utf8",
  );

  /**
   * Capabilities the server exists to expose, and the tool that must reach
   * each one. Listed rather than derived: the question "should this be
   * callable" is a design decision, and a derived list would answer it by
   * accident.
   */
  const REACHABLE = [
    { capability: "markEntriesDigested", tool: "record_digest_outcome" },
    { capability: "gatherDigestMaterial", tool: "gather_all_undigested_ai_mistakes" },
    { capability: "appendMemory", tool: "append_memory" },
    { capability: "createMemoryFile", tool: "create_memory_file" },
  ];

  for (const { capability, tool } of REACHABLE) {
    test(`${capability} is reachable through ${tool}`, () => {
      expect(index).toContain(`"${tool}"`);
      expect(index).toContain(capability);
    });
  }

  test("the digest can be closed, not only opened", () => {
    // The specific gap: gathering existed, marking did not, so the loop ran
    // one way forever.
    const opens = index.includes("gather_all_undigested_ai_mistakes");
    const closes = index.includes("record_digest_outcome");
    expect(opens && closes, "a digest that cannot be closed is not a loop").toBe(
      true,
    );
  });
});
