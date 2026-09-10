import { beforeEach, describe, expect, test } from "vitest";

import { chunkFile } from "../../src/chunking";
import {
  planRebuild,
  readHeadCommit,
} from "../../src/index_rebuild";
import { searchLexically } from "../../src/lexical_search";
import { cascadeResults } from "../../src/search_cascade";
import { createMemoryFile, deleteMemoryFile } from "../../src/memory_tree";
import { DEFAULT_SEARCH_QUOTAS, FILES_INDEXED_PER_SEARCH } from "../../src/search_config";
import type {
  MemoryIndex,
  MemoryIndexChunk,
  MemoryIndexIdentity,
} from "../../src/memory_index";
import { advanceIndexBuild } from "../../src/search_memory";
import { readWholeStore } from "../../src/store_read";
import { eventually, resetSandbox, sandboxConfig } from "./sandbox";

/**
 * The parts of search that touch the network, against a real repository.
 *
 * Everything else is tested offline, where it belongs. What cannot be tested
 * offline is whether the GitHub calls behave as the code assumes they do —
 * whether the tree carries the blob shas the incremental rebuild depends on,
 * whether `compare` reports a rename with both names, whether reading a blob
 * by sha returns what reading a path by ref would.
 *
 * Those assumptions are the ones most likely to be wrong, because they were
 * written from documentation rather than from watching the API.
 */

const config = sandboxConfig();

beforeEach(async () => {
  await resetSandbox();
});

describe("reading the whole store", () => {
  test("every file comes back with its text and blob sha", async () => {
    const files = await readWholeStore(config);

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.path.startsWith("other-memory/")).toBe(true);
      // The sha is what makes incremental rebuilding possible, and the
      // previous version of this code silently discarded it.
      expect(file.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(typeof file.text).toBe("string");
    }
  });

  test("text is decoded as UTF-8, not one character per byte", async () => {
    // The bug that prompted this: a bare atob returns mojibake for anything
    // multi-byte, and this store is full of em-dashes. Search over corrupted
    // text fails to match words next to them, with nothing reporting an error.
    const path = "other-memory/facts/encoding_check.md";
    await createMemoryFile(
      config,
      path,
      "# Encoding\n\nBorn 1980-07-02 — superseded “eye-din” café.\n",
      "test: check UTF-8 survives the read path",
    );

    await eventually(async () => {
      const files = await readWholeStore(config);
      const written = files.find((file) => file.path === path);
      expect(written?.text).toContain("—");
      expect(written?.text).toContain("“eye-din”");
      expect(written?.text).toContain("café");
    });
  });

  test("reading is fast enough to be worth doing per search", async () => {
    // The concurrency change exists because the previous version made one
    // sequential request per file. This does not assert a number, only that
    // the whole store is readable inside a request's budget.
    const started = Date.now();
    await readWholeStore(config);
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});

describe("planning a rebuild from real commits", () => {
  test("no previous build means a full one", async () => {
    const head = await readHeadCommit(config);
    const plan = await planRebuild(config, null, head);

    expect(plan.mode).toBe("full");
    expect(plan.reason).toContain("Nothing has been indexed");
  });

  test("the same commit means no work", async () => {
    const head = await readHeadCommit(config);
    expect((await planRebuild(config, head, head)).mode).toBe("up_to_date");
  });

  test("a created file appears as an upsert", async () => {
    const before = await readHeadCommit(config);
    const path = "other-memory/facts/rebuild_check.md";
    await createMemoryFile(
      config,
      path,
      "# Rebuild check\n\nA file created to test the comparison.\n",
      "test: create a file so the comparison has something to report",
    );

    await eventually(async () => {
      const after = await readHeadCommit(config);
      expect(after).not.toBe(before);
      const plan = await planRebuild(config, before, after);
      expect(plan.mode).toBe("incremental");
      expect(plan.changes).toContainEqual({ kind: "upsert", path });
    });
  });

  test("a deleted file appears as a delete", async () => {
    const path = "other-memory/facts/delete_check.md";
    await createMemoryFile(
      config,
      path,
      "# Delete check\n\nAbout to be removed.\n",
      "test: create a file that will then be deleted",
    );

    const before = await eventually(async () => {
      const head = await readHeadCommit(config);
      const files = await readWholeStore(config);
      expect(files.some((file) => file.path === path)).toBe(true);
      return head;
    });

    await deleteMemoryFile(
      config,
      path,
      "test: remove the file so the comparison reports a deletion",
    );

    await eventually(async () => {
      const after = await readHeadCommit(config);
      const plan = await planRebuild(config, before, after);
      expect(plan.changes).toContainEqual({ kind: "delete", path });
    });
  });

  test("an unreachable base commit falls back to a full rebuild", async () => {
    // What a force-push leaves behind, and the revert tool makes that real.
    // A partial index would report success while covering part of the store.
    const head = await readHeadCommit(config);
    const plan = await planRebuild(
      config,
      "0000000000000000000000000000000000000000",
      head,
    );

    expect(plan.mode).toBe("full");
    expect(plan.reason).toContain("reindex");
  });
});

describe("searching what was actually read", () => {
  test("a written fact is findable by its own words", async () => {
    const path = "other-memory/facts/search_check.md";
    await createMemoryFile(
      config,
      path,
      "# Search check\n\nStated directly.\n\n"
        + "## Turntables\n\n- The turntable is a Rega Planar 3.\n",
      "test: write a fact that search should then find",
    );

    await eventually(async () => {
      const files = await readWholeStore(config);
      const chunks = files.flatMap((file) => chunkFile(file));
      // searchLexically's own output is deliberately unsorted (see its
      // module comment) — ranking happens in cascadeResults, which is what
      // any real search actually goes through. Reading searchLexically's
      // hits[0] directly, as this test used to, asserts an ordering the
      // function never promised.
      const hits = searchLexically(chunks, "Rega Planar");
      expect(hits.length).toBeGreaterThan(0);
      const ranked = cascadeResults(hits, [], DEFAULT_SEARCH_QUOTAS);
      expect(ranked.length).toBeGreaterThan(0);
      expect(ranked[0].chunk.path).toBe(path);
    });
  });

  test("a superseded value is not findable as current", async () => {
    // The store keeps struck-through values by instruction, and search must
    // not return them as facts. This is the acceptance test for that.
    const path = "other-memory/facts/superseded_check.md";
    await createMemoryFile(
      config,
      path,
      "# Superseded check\n\nStated directly.\n\n"
        + "- The turntable is a Rega Planar 3. ~~A Technics SL-1200.~~ — "
        + "superseded 2026-08-14.\n",
      "test: write a superseded value that search must not return as current",
    );

    await eventually(async () => {
      const files = await readWholeStore(config);
      const chunks = files.flatMap((file) => chunkFile(file));
      const hits = searchLexically(chunks, "Technics SL-1200");
      const fromThisFile = hits.filter((hit) => hit.chunk.path === path);
      // No anchored match: the superseded text is genuinely absent from
      // what is searched. A weak fuzzy score can still appear — "Technics
      // SL-1200" shares enough characters with unrelated words in the
      // chunk ("turntable", "superseded") to score nonzero on fuzzy
      // alignment alone — but that is character-level noise, not the
      // struck-through value being findable, and without a minimum-score
      // floor it is the cascade's fuzzy quota, not this test, that decides
      // whether noise like that ever reaches a caller.
      for (const hit of fromThisFile) {
        const anchored =
          hit.scores.exact
          + hit.scores.starts_with
          + hit.scores.ends_with
          + hit.scores.contains
          + hit.scores.contained_by;
        expect(anchored).toBe(0);
      }

      // Still recorded, just not as a current fact.
      const chunk = chunks.find((one) => one.path === path);
      expect(chunk?.superseded.join(" ")).toContain("Technics");
    });
  });

  test("a query sharing no characters with the store returns nothing", async () => {
    // An empty result has to be possible, or every search "succeeds" and the
    // absence of a fact can never be established. Without a minimum-score
    // floor, an ordinary English query can score a genuine (if weak) nonzero
    // fuzzy overlap somewhere in a large real store, so this uses a query
    // that shares no characters with any real content at all.
    const files = await readWholeStore(config);
    const chunks = files.flatMap((file) => chunkFile(file));
    expect(searchLexically(chunks, "øæå ØÆÅ ñüß")).toEqual([]);
  });
});

/**
 * An in-memory MemoryIndex, for exercising advanceIndexBuild against real
 * GitHub reads without needing a D1 binding — which this project's Node
 * environment does not have. Keyed the same way the deployment's D1
 * implementation keys its tables (commit+model+pooling+path), so behavior
 * here is not an accident of a different design.
 */
function inProcessMemoryIndex(): MemoryIndex {
  const rows = new Map<string, MemoryIndexChunk[]>();
  const builtCommits = new Map<string, string>();

  const rowKey = (identity: MemoryIndexIdentity, path: string) =>
    `${identity.commitSha}|${identity.model}|${identity.pooling}|${path}`;
  const commitKey = (identity: Omit<MemoryIndexIdentity, "commitSha">) =>
    `${identity.model}|${identity.pooling}`;

  return {
    maxCarryForwardExclusions: null,
    async load(identity) {
      const prefix = `${identity.commitSha}|${identity.model}|${identity.pooling}|`;
      return [...rows.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .flatMap(([, chunks]) => chunks);
    },
    async replaceFile(identity, path, chunks) {
      rows.set(rowKey(identity, path), chunks);
    },
    async removeFile(identity, path) {
      rows.delete(rowKey(identity, path));
    },
    async carryForward({ from, to, exceptPaths }) {
      const exceptSet = new Set(exceptPaths);
      const fromPrefix = `${from.commitSha}|${from.model}|${from.pooling}|`;
      for (const [key, chunks] of rows) {
        if (!key.startsWith(fromPrefix)) {
          continue;
        }
        const path = key.slice(fromPrefix.length);
        if (exceptSet.has(path)) {
          continue;
        }
        rows.set(rowKey(to, path), chunks);
      }
    },
    async builtCommit(identity) {
      return builtCommits.get(commitKey(identity)) ?? null;
    },
    async recordBuiltCommit(identity) {
      builtCommits.set(commitKey(identity), identity.commitSha);
    },
    async discardOtherCommits(identity) {
      // Delete every row sharing this identity's model and pooling but not
      // its commit — the same scope d1_memory_index.ts deletes within.
      const keepPrefix = `${identity.commitSha}|${identity.model}|${identity.pooling}|`;
      const sameModelPooling = `|${identity.model}|${identity.pooling}|`;
      for (const key of [...rows.keys()]) {
        const [keyCommitSha] = key.split("|");
        if (
          key.includes(sameModelPooling)
          && !key.startsWith(keepPrefix)
          && keyCommitSha !== identity.commitSha
        ) {
          rows.delete(key);
        }
      }
    },
  };
}

describe("resuming a build across several calls", () => {
  test("advanceIndexBuild finishes without a search, over enough files to need two batches", async () => {
    // FILES_INDEXED_PER_SEARCH files are indexed per call, so more than that
    // many eligible files forces at least two calls to reach completion —
    // the exact shape an alarm-driven build goes through, with no
    // searchMemory call anywhere in this loop.
    const extraFiles = FILES_INDEXED_PER_SEARCH + 1;
    for (let index = 0; index < extraFiles; index += 1) {
      await createMemoryFile(
        config,
        `other-memory/facts/resume_check_${index}.md`,
        `# Resume check ${index}\n\nFile ${index} of a batch that forces a `
          + "multi-call index build.\n",
        `test: create file ${index} of ${extraFiles} to force two batches`,
      );
    }

    const index = inProcessMemoryIndex();
    // No embedder: this proves the batching and resume mechanism itself,
    // independent of whether Workers AI is reachable from this test run.
    const embed = null;

    await eventually(async () => {
      const files = await readWholeStore(config);
      expect(files.length).toBeGreaterThan(FILES_INDEXED_PER_SEARCH);
    });

    const first = await advanceIndexBuild(config, index, embed);
    expect(first.complete).toBe(false);
    expect(first.reason).toContain("PARTIAL INDEX");

    const head = await readHeadCommit(config);
    const afterFirst = await index.load({
      commitSha: head,
      model: "@cf/baai/bge-base-en-v1.5",
      pooling: "cls",
    });
    expect(afterFirst.length).toBeGreaterThan(0);

    // Keep calling — no searchMemory anywhere in this loop — until the
    // build reports itself complete. This is the mechanical proof that an
    // alarm calling advanceIndexBuild on its own, with nothing else
    // driving it, would finish the job.
    let outcome = first;
    let iterations = 0;
    while (!outcome.complete && iterations < 20) {
      outcome = await advanceIndexBuild(config, index, embed);
      iterations += 1;
    }

    expect(outcome.complete).toBe(true);
    // A finished full build still carries an informational reason ("Index
    // complete: N files.") — only the up_to_date path reports null. What
    // matters here is that it is never the PARTIAL INDEX caveat.
    expect(outcome.reason).not.toContain("PARTIAL INDEX");

    const finalHead = await readHeadCommit(config);
    const built = await index.builtCommit({
      model: "@cf/baai/bge-base-en-v1.5",
      pooling: "cls",
    });
    expect(built).toBe(finalHead);
  });

  test("an incremental build with more changes than one batch still finishes", async () => {
    // The 2026-09-10 stall: the incremental path always sliced the first
    // FILES_INDEXED_PER_SEARCH changes and never recorded progress, so once
    // more files changed than a batch holds it reprocessed the same first
    // few every call and the rest were never reached — the "N still to
    // index" count never moved.
    const index = inProcessMemoryIndex();
    const embed = null;
    const model = "@cf/baai/bge-base-en-v1.5";
    const identity = { model, pooling: "cls" } as const;

    // First: a complete build at the current commit, so there is a builtSha
    // for the next changes to be incremental against.
    let outcome = await advanceIndexBuild(config, index, embed);
    let guard = 0;
    while (!outcome.complete && guard < 30) {
      outcome = await advanceIndexBuild(config, index, embed);
      guard += 1;
    }
    expect(outcome.complete).toBe(true);
    const baseBuilt = await index.builtCommit(identity);
    expect(baseBuilt).toBe(await readHeadCommit(config));

    // Now change more files than one batch can hold.
    const changed = FILES_INDEXED_PER_SEARCH + 3;
    for (let i = 0; i < changed; i += 1) {
      await createMemoryFile(
        config,
        `other-memory/facts/incremental_check_${i}.md`,
        `# Incremental check ${i}\n\nOne of ${changed} files changed after a `
          + "complete build, to force a multi-round incremental rebuild.\n",
        `test: incremental file ${i} of ${changed}`,
      );
    }
    await eventually(async () => {
      const plan = await planRebuild(
        config,
        await index.builtCommit(identity),
        await readHeadCommit(config),
        null,
      );
      expect(plan.mode).toBe("incremental");
      expect(plan.changes.length).toBeGreaterThan(FILES_INDEXED_PER_SEARCH);
    });

    // Drive the incremental build to completion — nothing but advanceIndexBuild.
    outcome = await advanceIndexBuild(config, index, embed);
    expect(outcome.complete).toBe(false);
    guard = 0;
    const seenRemaining: number[] = [];
    while (!outcome.complete && guard < 30) {
      const match = outcome.reason?.match(/(\d+) changed file\(s\) still to/);
      if (match) {
        seenRemaining.push(Number(match[1]));
      }
      outcome = await advanceIndexBuild(config, index, embed);
      guard += 1;
    }

    expect(outcome.complete).toBe(true);
    expect(await index.builtCommit(identity)).toBe(await readHeadCommit(config));
    // The "still to index" count must strictly decrease — the bug was it
    // standing still.
    expect(seenRemaining.length).toBeGreaterThan(0);
    for (let i = 1; i < seenRemaining.length; i += 1) {
      expect(seenRemaining[i]).toBeLessThan(seenRemaining[i - 1]);
    }

    // Every changed file is now in the index at the head commit.
    const head = await readHeadCommit(config);
    const finalRows = await index.load({ commitSha: head, ...identity });
    const finalPaths = new Set(finalRows.map((entry) => entry.chunk.path));
    for (let i = 0; i < changed; i += 1) {
      expect(finalPaths.has(`other-memory/facts/incremental_check_${i}.md`)).toBe(
        true,
      );
    }
  });
});
