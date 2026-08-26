import { describe, expect, test } from "vitest";

import {
  applyDepth,
  describeDeep,
  isDeep,
  summariseDeep,
} from "../src/deep_memory";

/**
 * Context economy, not privacy. Idin ruled that on 2026-08-13, and it is why
 * there is no gate here: deep files are left out of the default listing and
 * readable by path at any time.
 *
 * The property that matters most is that holding files back is never silent.
 * An agent that does not know the rest exists will answer confidently from a
 * store it could not see all of, which is worse than a longer listing.
 */

const PATHS = [
  "other-memory/facts/core.md",
  "other-memory/facts/frodo.md",
  "other-memory/work/todos/open/2026-08-13_do_something.md",
  "other-memory/work/todos/resolved/2026-08-12_finished_thing.md",
  "other-memory/work/todos/resolved/2026-08-12_another_finished_thing.md",
  "other-memory/messages/inbox/ada/2026-08-13T00-00-00-000Z_kip_hello.md",
  "other-memory/messages/archive/kip/2026-08-01T00-00-00-000Z_ada_older.md",
];

describe("isDeep", () => {
  test("resolved work is deep", () => {
    expect(isDeep("other-memory/work/todos/resolved/2026-08-12_finished_thing.md")).toBe(true);
  });

  test("acted-on correspondence is deep", () => {
    expect(isDeep("other-memory/messages/archive/kip/note.md")).toBe(true);
  });

  test("facts are not", () => {
    expect(isDeep("other-memory/facts/core.md")).toBe(false);
  });

  test("an unresolved todo is not", () => {
    // The point is to hide what has already happened, not what is outstanding.
    expect(isDeep("other-memory/work/todos/open/2026-08-13_do_something.md")).toBe(
      false,
    );
  });

  test("an unread message is not", () => {
    expect(isDeep("other-memory/messages/inbox/ada/note.md")).toBe(false);
  });
});

describe("applyDepth", () => {
  test("leaves resolved work out by default", () => {
    const shown = applyDepth(PATHS, { includeDeep: false });
    expect(shown).toHaveLength(4);
    expect(shown.some((path) => path.includes("/past/"))).toBe(false);
    expect(shown.some((path) => path.includes("/archive/"))).toBe(false);
  });

  test("shows everything when asked", () => {
    expect(applyDepth(PATHS, { includeDeep: true })).toHaveLength(PATHS.length);
  });

  test("keeps current facts and outstanding work", () => {
    const shown = applyDepth(PATHS, { includeDeep: false });
    expect(shown).toContain("other-memory/facts/core.md");
    expect(shown).toContain("other-memory/work/todos/open/2026-08-13_do_something.md");
  });
});

describe("describeDeep", () => {
  test("says how many were held back, and where", () => {
    // Silence here would be the failure: an agent cannot ask for what it does
    // not know exists.
    const note = describeDeep(summariseDeep(PATHS));
    expect(note).toContain("3 further file(s)");
    expect(note).toContain("todos/resolved/");
    expect(note).toContain("messages/archive/");
  });

  test("says how to reach them", () => {
    expect(describeDeep(summariseDeep(PATHS))).toMatch(/read one by path|full listing/i);
  });

  test("says nothing when nothing is held back", () => {
    const note = describeDeep(summariseDeep(["other-memory/facts/core.md"]));
    expect(note).toBeNull();
  });

  test("counts each area separately", () => {
    const summary = summariseDeep(PATHS);
    expect(summary.total).toBe(3);
    expect(summary.counts).toHaveLength(2);
  });
});
