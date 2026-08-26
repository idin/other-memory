import { describe, expect, test } from "vitest";

import { planChanges, type ComparedFile } from "../src/index_rebuild";

/**
 * Turning a git comparison into work.
 *
 * The rename case is the one worth having tests for: git reports one entry
 * carrying both names, and treating it as an ordinary change leaves the old
 * path's rows behind as orphans — searchable under a name that no longer
 * exists. The rename tool makes that a real path rather than a hypothetical.
 */

function file(
  filename: string,
  status: string,
  previous?: string,
): ComparedFile {
  return previous
    ? { filename, status, previous_filename: previous }
    : { filename, status };
}

describe("each status becomes the right work", () => {
  test("an added file is inserted", () => {
    expect(planChanges([file("other-memory/facts/new.md", "added")])).toEqual([
      { kind: "upsert", path: "other-memory/facts/new.md" },
    ]);
  });

  test("a modified file is one upsert, not a delete and an insert", () => {
    // The store deletes by path before inserting, so the two-step is a
    // property of the storage primitive rather than a second plan entry.
    expect(planChanges([file("other-memory/facts/core.md", "modified")])).toEqual([
      { kind: "upsert", path: "other-memory/facts/core.md" },
    ]);
  });

  test("a removed file is deleted", () => {
    expect(planChanges([file("other-memory/facts/gone.md", "removed")])).toEqual([
      { kind: "delete", path: "other-memory/facts/gone.md" },
    ]);
  });

  test("an unchanged file is no work at all", () => {
    expect(planChanges([file("other-memory/facts/core.md", "unchanged")])).toEqual(
      [],
    );
  });

  test("an unrecognised status is treated as a change", () => {
    // Being wrong here costs one re-chunk. Ignoring it costs a stale row
    // nobody finds out about.
    expect(planChanges([file("other-memory/facts/x.md", "something_new")])).toEqual(
      [{ kind: "upsert", path: "other-memory/facts/x.md" }],
    );
  });
});

describe("renames", () => {
  test("both halves are planned", () => {
    expect(
      planChanges([
        file("other-memory/facts/new.md", "renamed", "other-memory/facts/old.md"),
      ]),
    ).toEqual([
      { kind: "delete", path: "other-memory/facts/old.md" },
      { kind: "upsert", path: "other-memory/facts/new.md" },
    ]);
  });

  test("the old path is deleted before the new one is written", () => {
    // Order matters when both resolve to the same rows.
    const changes = planChanges([
      file("other-memory/facts/a.md", "renamed", "other-memory/facts/b.md"),
    ]);
    expect(changes[0].kind).toBe("delete");
  });

  test("a rename from outside the namespace only inserts", () => {
    expect(
      planChanges([
        file("other-memory/facts/moved_in.md", "renamed", "notes/scratch.md"),
      ]),
    ).toEqual([{ kind: "upsert", path: "other-memory/facts/moved_in.md" }]);
  });

  test("a rename out of the namespace only deletes", () => {
    expect(
      planChanges([
        file("notes/scratch.md", "renamed", "other-memory/facts/moved_out.md"),
      ]),
    ).toEqual([{ kind: "delete", path: "other-memory/facts/moved_out.md" }]);
  });
});

describe("files outside the namespace", () => {
  test("cost nothing", () => {
    // This repository holds more than the memory store, so a commit touching
    // the worker source should not trigger any reindexing.
    expect(
      planChanges([
        file("mcp-servers/memory/src/worker.ts", "modified"),
        file("README.md", "modified"),
        file("other-memory/facts/core.md", "modified"),
      ]),
    ).toEqual([{ kind: "upsert", path: "other-memory/facts/core.md" }]);
  });

  test("a commit touching nothing in the store is no work", () => {
    expect(planChanges([file("package.json", "modified")])).toEqual([]);
  });
});

describe("a realistic mixed commit", () => {
  test("every kind is handled in one pass", () => {
    const changes = planChanges([
      file("other-memory/facts/new.md", "added"),
      file("other-memory/facts/core.md", "modified"),
      file("other-memory/work/todos/resolved/done.md", "renamed", "other-memory/work/todos/open/x.md"),
      file("other-memory/facts/stale.md", "removed"),
      file("scripts/build.sh", "modified"),
    ]);
    expect(changes).toEqual([
      { kind: "upsert", path: "other-memory/facts/new.md" },
      { kind: "upsert", path: "other-memory/facts/core.md" },
      { kind: "delete", path: "other-memory/work/todos/open/x.md" },
      { kind: "upsert", path: "other-memory/work/todos/resolved/done.md" },
      { kind: "delete", path: "other-memory/facts/stale.md" },
    ]);
  });

  test("an empty comparison is no work", () => {
    expect(planChanges([])).toEqual([]);
  });
});
