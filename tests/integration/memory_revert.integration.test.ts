import { beforeEach, describe, expect, test } from "vitest";

import { confirmationToken, isValidConfirmation } from "../../src/confirmation";
import { readMemory } from "../../src/memory_repo";
import { applyRevert, planRevert, revertOperation } from "../../src/memory_revert";
import { createMemoryFile } from "../../src/memory_tree";
import { FIXTURE_TODO, eventually, resetSandbox, sandboxConfig } from "./sandbox";

/**
 * Reverting is the destructive path, and the confirmation token is the thing
 * standing between an agent and a mistake. These tests establish what it
 * actually protects, which turns out not to be what it appears to.
 */

const config = sandboxConfig();

/** Any secret will do: the tests only need the token to be self-consistent. */
const SECRET = "integration-test-secret";

/** After every fixture commit, so a revert to here restores all of them. */
const AFTER_THE_FIXTURE = "2026-03-01T00:00:00Z";

/** Between the second and third fixture commits. */
const BEFORE_THE_TODO = "2026-01-13T00:00:00Z";

beforeEach(async () => {
  await resetSandbox();
});

describe("planning a revert", () => {
  test("resolves a timestamp to the commit at or before it", async () => {
    const plan = await planRevert(config, BEFORE_THE_TODO);

    expect(plan.targetCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(plan.targetCommitMessage).toContain("record who this invented person is");
  });

  test("a timestamp before the repository existed fails", async () => {
    await expect(planRevert(config, "2001-01-01T00:00:00Z")).rejects.toThrow(
      /no commit exists/i,
    );
  });

  test("an unparseable timestamp fails before any request is made", async () => {
    await expect(planRevert(config, "the day before yesterday")).rejects.toThrow();
  });

  test("names the files it would remove", async () => {
    await createMemoryFile(
      config,
      "other-memory/facts/added_later.md",
      "# Added later\n",
      "feat: add a file after the fixture",
    );

    await eventually(async () => {
      const plan = await planRevert(config, AFTER_THE_FIXTURE);
      expect(plan.removed).toContain("other-memory/facts/added_later.md");
    });
  });

  test("changes nothing on its own", async () => {
    await planRevert(config, BEFORE_THE_TODO);

    const stillThere = await readMemory(config, FIXTURE_TODO);
    expect(stillThere.content).toContain("extractor fan");
  });
});

describe("applying a revert", () => {
  test("restores what the plan said it would", async () => {
    await createMemoryFile(
      config,
      "other-memory/facts/added_later.md",
      "# Added later\n",
      "feat: add a file after the fixture",
    );

    // Retry the plan, not just the assertion after it. planRevert reads the
    // git tree, and a file GitHub has accepted is not always in the tree it
    // serves a moment later — the plan then comes back empty and applyRevert
    // refuses it as nothing to do.
    const plan = await eventually(async () => {
      const planned = await planRevert(config, AFTER_THE_FIXTURE);
      expect(planned.removed).toContain("other-memory/facts/added_later.md");
      return planned;
    });
    await applyRevert(config, plan, "chore: revert to the fixture");

    await eventually(async () => {
      await expect(
        readMemory(config, "other-memory/facts/added_later.md"),
      ).rejects.toThrow();
      const restored = await readMemory(config, "other-memory/facts/core.md");
      expect(restored.content).toContain("Wren Halloway");
    });
  });

  test("refuses when there is nothing to do", async () => {
    const plan = await planRevert(config, AFTER_THE_FIXTURE);
    await expect(
      applyRevert(config, plan, "chore: nothing to revert"),
    ).rejects.toThrow(/nothing to revert/i);
  });
});

describe("the confirmation token", () => {
  test("covers the files the plan would delete, not only the commit", async () => {
    // The sequence a user actually performs: ask what a revert would do, read
    // the answer, then confirm it. The token issued with the preview is what
    // authorises the second step.
    //
    // Between the two, something else writes to the repository — another
    // agent, another session, the user in a browser. The file it creates was
    // never in the plan that was shown and approved.
    //
    // A confirmation that still validates here is authorising a deletion
    // nobody saw. That is the whole point of asking.
    await createMemoryFile(
      config,
      "other-memory/facts/added_later.md",
      "# Added later\n",
      "feat: add a file after the fixture",
    );

    const previewed = await planRevert(config, AFTER_THE_FIXTURE);
    const now = Date.now();
    const token = await confirmationToken(
      SECRET,
      await revertOperation(previewed),
      now,
    );

    // ... and now somebody else writes.
    await createMemoryFile(
      config,
      "other-memory/facts/written_meanwhile.md",
      "# Written between the preview and the confirmation\n",
      "feat: a file the user never saw in any plan",
    );

    // The confirm call recomputes the plan, which is where the new file joins
    // the deletions.
    const recomputed = await eventually(async () => {
      const replanned = await planRevert(config, AFTER_THE_FIXTURE);
      expect(replanned.removed).toContain("other-memory/facts/written_meanwhile.md");
      return replanned;
    });

    const stillValid = await isValidConfirmation(
      SECRET,
      await revertOperation(recomputed),
      token,
      now,
    );

    // The token was issued for a plan that removed one file. It must not
    // authorise a plan that removes two.
    expect(stillValid).toBe(false);
  });
});
