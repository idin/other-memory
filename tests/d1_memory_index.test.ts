import { describe, expect, test } from "vitest";

import { d1MemoryIndex } from "../src/d1/memory_index";
import type { MemoryIndexIdentity } from "../src/memory_index";

/**
 * A Worker has a hard ceiling on subrequests per invocation. Every method on
 * the D1 index called `ensureTables()`, which ran an unconditional
 * `CREATE TABLE IF NOT EXISTS` batch — so a full-rebuild round (one load,
 * twelve `replaceFile`, the built-commit bookkeeping) spent a dozen
 * subrequests re-creating tables that already existed. On 2026-09-10 that
 * pushed the round past the limit and left `search_memory` and the index-build
 * alarm both failing on every call.
 *
 * `ensureTables` is memoized now. These tests pin that it runs once per
 * instance, and that a failed create is not cached as done.
 */

const IDENTITY: MemoryIndexIdentity = {
  commitSha: "abc123",
  model: "m",
  pooling: "mean",
};

type Call = { kind: "batch" | "run" | "all" | "first"; sql: string };

/**
 * A D1 stand-in that records every statement executed, so a test can count
 * how many times the table-creating batch ran.
 */
function fakeDatabase(options: { failCreate?: boolean } = {}) {
  const calls: Call[] = [];
  let createAttempts = 0;

  function prepare(sql: string) {
    return {
      sql,
      bind() {
        return this;
      },
      async all<T>() {
        calls.push({ kind: "all", sql });
        return { results: [] as T[] };
      },
      async first<T>() {
        calls.push({ kind: "first", sql });
        return null as T | null;
      },
      async run() {
        calls.push({ kind: "run", sql });
        return { success: true };
      },
    };
  }

  const database = {
    prepare,
    async batch(statements: { sql: string }[]) {
      const isCreate = statements.some((s) => s.sql.includes("CREATE TABLE"));
      // Recorded before any throw, so a failed create still counts as an
      // attempt the way a real subrequest would.
      calls.push({ kind: "batch", sql: statements.map((s) => s.sql).join("; ") });
      if (isCreate) {
        createAttempts += 1;
        if (options.failCreate && createAttempts === 1) {
          throw new Error("create failed");
        }
      }
      return statements.map(() => ({ success: true }));
    },
  };

  return {
    database: database as unknown as D1Database,
    calls,
    createBatchCount: () =>
      calls.filter((c) => c.kind === "batch" && c.sql.includes("CREATE TABLE"))
        .length,
  };
}

describe("d1 index does not re-create tables on every call", () => {
  test("many operations run the create batch exactly once", async () => {
    const { database, createBatchCount } = fakeDatabase();
    const index = d1MemoryIndex(database, { now: () => 0 });

    await index.load(IDENTITY);
    await index.load(IDENTITY);
    await index.builtCommit({ model: "m", pooling: "mean" });
    await index.replaceFile(IDENTITY, "other-memory/facts/a.md", []);
    await index.replaceFile(IDENTITY, "other-memory/facts/b.md", []);
    await index.removeFile(IDENTITY, "other-memory/facts/c.md");
    await index.recordBuiltCommit(IDENTITY);

    expect(createBatchCount()).toBe(1);
  });

  test("a failed create is retried, not cached as done", async () => {
    const { database, createBatchCount } = fakeDatabase({ failCreate: true });
    const index = d1MemoryIndex(database, { now: () => 0 });

    await expect(index.load(IDENTITY)).rejects.toThrow("create failed");
    // Second call must try again rather than reuse the rejected promise.
    await index.load(IDENTITY);

    expect(createBatchCount()).toBe(2);
  });
});
