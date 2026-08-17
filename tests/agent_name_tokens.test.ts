import { describe, expect, test } from "vitest";

import { unwrapAgentToken, wrapAgentToken } from "../src/agent_name_tokens";

describe("wrapAgentToken and unwrapAgentToken", () => {
  test("wrapping then unwrapping returns the original value", () => {
    expect(unwrapAgentToken(wrapAgentToken("a1b2c3d4"))).toBe("a1b2c3d4");
  });

  test("the wrapper is built from guillemets and named start/end markers", () => {
    expect(wrapAgentToken("a1b2c3d4")).toBe(
      "«agent_token_start:a1b2c3d4:agent_token_end»",
    );
  });

  test("plain text with no wrapper is not mistaken for a token", () => {
    expect(unwrapAgentToken("a1b2c3d4")).toBeNull();
    expect(unwrapAgentToken("just some ordinary sentence")).toBeNull();
  });

  test("a wrapper missing its closing marker is not unwrapped", () => {
    expect(unwrapAgentToken("«agent_token_start:a1b2c3d4")).toBeNull();
  });

  test("surrounding whitespace does not prevent unwrapping", () => {
    expect(unwrapAgentToken("  «agent_token_start:a1b2c3d4:agent_token_end»  ")).toBe(
      "a1b2c3d4",
    );
  });
});
