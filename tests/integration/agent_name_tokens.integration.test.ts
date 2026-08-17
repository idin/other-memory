import { beforeEach, describe, expect, test } from "vitest";

import { wrapAgentToken, verifyAgentNameToken } from "../../src/agent_name_tokens";
import { readWholeStore } from "../../src/store_read";
import { listMemoryFiles } from "../../src/memory_tree";
import { resetSandbox, sandboxConfig } from "./sandbox";

const config = sandboxConfig();

beforeEach(async () => {
  await resetSandbox();
});

describe("verifying an agent name against the real sandbox", () => {
  test("the correct token verifies", async () => {
    const verdict = await verifyAgentNameToken(
      config,
      "Ada",
      wrapAgentToken("fixture-test-token-for-ada"),
    );
    expect(verdict).toEqual({ outcome: "verified" });
  });

  test("name matching is loose, same as everywhere else agent names are used", async () => {
    const verdict = await verifyAgentNameToken(
      config,
      "A-D-A",
      wrapAgentToken("fixture-test-token-for-ada"),
    );
    expect(verdict).toEqual({ outcome: "verified" });
  });

  test("the wrong token does not verify", async () => {
    const verdict = await verifyAgentNameToken(
      config,
      "Ada",
      wrapAgentToken("not-the-real-token"),
    );
    expect(verdict).toEqual({ outcome: "token_mismatch" });
  });

  test("an unwrapped token value is rejected the same as a wrong one", async () => {
    const verdict = await verifyAgentNameToken(
      config,
      "Ada",
      "fixture-test-token-for-ada",
    );
    expect(verdict).toEqual({ outcome: "token_mismatch" });
  });

  test("a name with no entry at all has no token on record", async () => {
    const verdict = await verifyAgentNameToken(
      config,
      "Nobody",
      wrapAgentToken("anything"),
    );
    expect(verdict).toEqual({ outcome: "no_token_on_record" });
  });
});

describe("hidden_from_agents is invisible to every reading tool", () => {
  test("readWholeStore never returns anything under it", async () => {
    const files = await readWholeStore(config);
    expect(
      files.some((file) => file.path.startsWith("other-memory/hidden_from_agents/")),
    ).toBe(false);
  });

  test("listMemoryFiles never lists anything under it", async () => {
    const entries = await listMemoryFiles(config);
    expect(
      entries.some((entry) => entry.path.startsWith("other-memory/hidden_from_agents/")),
    ).toBe(false);
  });
});
