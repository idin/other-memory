import { beforeEach, describe, expect, test } from "vitest";

import { appendMemory, readMemory } from "../../src/memory_repo";
import {
  createMemoryFile,
  deleteMemoryFile,
  listMemoryFiles,
  moveMemoryFile,
} from "../../src/memory_tree";
import {
  eventually,
  FIXTURE_CORE_FACTS,
  FIXTURE_INSTRUCTIONS,
  resetSandbox,
  sandboxConfig,
} from "./sandbox";

/**
 * These tests talk to a real GitHub repository.
 *
 * Everything they cover was previously untested, because none of it can be
 * exercised without a server on the other end. The guards are checked here
 * against real API responses rather than against a string, since a guard that
 * only ever sees inputs a test invented has not been shown to guard anything.
 */

const config = sandboxConfig();

beforeEach(async () => {
  await resetSandbox();
});

describe("reading", () => {
  test("reads a file that exists", async () => {
    const file = await readMemory(config, FIXTURE_CORE_FACTS);

    expect(file.path).toBe(FIXTURE_CORE_FACTS);
    expect(file.content).toContain("Wren Halloway");
    expect(file.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("a missing file fails rather than returning nothing", async () => {
    await expect(readMemory(config, "other-memory/facts/not_here.md")).rejects.toThrow();
  });

  test("lists every stored file with its size", async () => {
    const files = await listMemoryFiles(config);
    const paths = files.map((file) => file.path);

    expect(paths).toContain(FIXTURE_CORE_FACTS);
    expect(paths).toContain("other-memory/facts/home/kitchen.md");
    expect(files.every((file) => file.bytes > 0)).toBe(true);
  });
});

describe("appending", () => {
  test("adds to the end and leaves what was there", async () => {
    const before = await readMemory(config, FIXTURE_CORE_FACTS);

    await appendMemory(
      config,
      FIXTURE_CORE_FACTS,
      "- Prefers rivers to lakes.",
      "feat: record a preference",
    );

    await eventually(async () => {
      const after = await readMemory(config, FIXTURE_CORE_FACTS);
      expect(after.content).toContain(before.content.trimEnd());
      expect(after.content).toContain("Prefers rivers to lakes.");
    });
  });

  test("refuses to write to the read-only instructions", async () => {
    await expect(
      appendMemory(config, FIXTURE_INSTRUCTIONS, "- Sneaky.", "chore: should fail"),
    ).rejects.toThrow();

    const unchanged = await readMemory(config, FIXTURE_INSTRUCTIONS);
    expect(unchanged.content).not.toContain("Sneaky");
  });

  test("refuses to append nothing", async () => {
    await expect(
      appendMemory(config, FIXTURE_CORE_FACTS, "   \n  ", "chore: should fail"),
    ).rejects.toThrow();
  });

  test("appending to a path that does not exist yet creates it instead of failing", async () => {
    // 2026-09-11: an agent called append_memory on a mistake-log path that
    // had never been created, twice, and both attempts failed with GitHub's
    // own opaque error — "Not Found -
    // https://docs.github.com/rest/repos/contents#get-repository-content" —
    // and the write was lost both times. "Append this fact" has one
    // obviously correct behaviour whether or not the file already exists, so
    // append_memory now provides it directly rather than requiring the
    // caller to know in advance which tool to call.
    const missing = `other-memory/facts/does_not_exist_${Date.now()}.md`;

    const result = await appendMemory(
      config,
      missing,
      "- Some fact.",
      "test: create via append",
    );
    expect(result.path).toBe(missing);

    await eventually(async () => {
      const created = await readMemory(config, missing);
      expect(created.content).toContain("Some fact.");
    });
  });

  test("a stale sha is rejected rather than clobbering the file", async () => {
    // Read once, then let somebody else write, then try to write using what
    // was read. This is the promise the sha exists to keep, and until now
    // nothing had ever checked that GitHub actually keeps it.
    const stale = await readMemory(config, FIXTURE_CORE_FACTS);

    await appendMemory(
      config,
      FIXTURE_CORE_FACTS,
      "- Written by the other writer.",
      "feat: the write that lands first",
    );

    const octokit = new (await import("octokit")).Octokit({ auth: config.token });
    await expect(
      octokit.rest.repos.createOrUpdateFileContents({
        owner: config.owner,
        repo: config.repo,
        path: FIXTURE_CORE_FACTS,
        message: "feat: the write that should lose",
        content: btoa("clobbered"),
        sha: stale.sha,
        branch: config.branch,
      }),
    ).rejects.toMatchObject({ status: 409 });

    await eventually(async () => {
      const survived = await readMemory(config, FIXTURE_CORE_FACTS);
      expect(survived.content).toContain("Written by the other writer.");
      expect(survived.content).not.toBe("clobbered");
    });
  });
});

describe("creating, moving and deleting", () => {
  test("creates a file that did not exist", async () => {
    const path = "other-memory/facts/rivers.md";

    const result = await createMemoryFile(
      config,
      path,
      "# Rivers\n\nInvented.\n",
      "feat: add a file about rivers",
    );

    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    await eventually(async () => {
      const created = await readMemory(config, path);
      expect(created.content).toContain("# Rivers");
    });
  });

  test("refuses to create over something that exists", async () => {
    await expect(
      createMemoryFile(config, FIXTURE_CORE_FACTS, "replaced", "feat: should fail"),
    ).rejects.toThrow(/already exists/);

    const untouched = await readMemory(config, FIXTURE_CORE_FACTS);
    expect(untouched.content).toContain("Wren Halloway");
  });

  test("moves a file in a single commit", async () => {
    const from = FIXTURE_CORE_FACTS;
    const to = "other-memory/facts/person.md";
    const original = await readMemory(config, from);

    await moveMemoryFile(config, from, to, "refactor: rename the facts file");

    await eventually(async () => {
      const moved = await readMemory(config, to);
      expect(moved.content).toBe(original.content);
      await expect(readMemory(config, from)).rejects.toThrow();
    });
  });

  test("refuses to move onto an existing file", async () => {
    await expect(
      moveMemoryFile(
        config,
        FIXTURE_CORE_FACTS,
        "other-memory/facts/biscuit.md",
        "refactor: should fail",
      ),
    ).rejects.toThrow(/refusing to overwrite/i);
  });

  test("deletes a file and reports what was removed", async () => {
    const result = await deleteMemoryFile(
      config,
      "other-memory/facts/biscuit.md",
      "chore: remove the dog",
    );

    expect(result.bytesRemoved).toBeGreaterThan(0);
    await eventually(async () => {
      await expect(readMemory(config, "other-memory/facts/biscuit.md")).rejects.toThrow();
    });
  });

  test("refuses to delete the read-only instructions", async () => {
    await expect(
      deleteMemoryFile(config, FIXTURE_INSTRUCTIONS, "chore: should fail"),
    ).rejects.toThrow();

    const survived = await readMemory(config, FIXTURE_INSTRUCTIONS);
    expect(survived.content).toContain("Standing instructions");
  });

  test("refuses to touch anything outside the namespace", async () => {
    await expect(
      createMemoryFile(config, "README.md", "hello", "feat: should fail"),
    ).rejects.toThrow();
  });
});
