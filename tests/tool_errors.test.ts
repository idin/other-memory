import { describe, expect, it, test } from "vitest";

import {
  buildFailure,
  redactArguments,
  reportingFailures,
  type FailureSink,
  type ToolFailure,
} from "../src/tool_errors";

/**
 * Collect failures in memory so a test can assert on what was recorded.
 *
 * @returns A sink, and the array it writes into.
 */
function recordingSink(): { sink: FailureSink; recorded: ToolFailure[] } {
  const recorded: ToolFailure[] = [];
  return { sink: (failure) => void recorded.push(failure), recorded };
}

describe("reportingFailures", () => {
  it("returns the handler's result when nothing goes wrong", async () => {
    const { sink, recorded } = recordingSink();

    const result = await reportingFailures({
      tool: "read_memory",
      args: { path: "other-memory/facts/core.md" },
      login: "idin",
      sink,
      run: async () => ({ content: [{ type: "text", text: "the file" }] }),
    });

    expect(result).toEqual({ content: [{ type: "text", text: "the file" }] });
    expect(recorded).toHaveLength(0);
  });

  it("records a failure instead of throwing", async () => {
    const { sink, recorded } = recordingSink();

    const result = await reportingFailures({
      tool: "append_memory",
      args: { path: "other-memory/facts/core.md" },
      login: "idin",
      sink,
      run: async () => {
        throw new Error("GitHub returned 409");
      },
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].tool).toBe("append_memory");
    expect(recorded[0].message).toBe("GitHub returned 409");
    expect(recorded[0].login).toBe("idin");
    expect(result).toMatchObject({ isError: true });
  });

  it("tells the calling agent the call failed", async () => {
    const { sink } = recordingSink();

    const result = (await reportingFailures({
      tool: "read_and_archive_agent_notes",
      args: {},
      login: "idin",
      sink,
      run: async () => {
        throw new Error("no mailbox");
      },
    })) as { content: [{ text: string }]; isError: true };

    // An agent that cannot tell a failure from an empty result will report
    // the empty result to the user as though it were the answer.
    expect(result.content[0].text).toContain("read_and_archive_agent_notes");
    expect(result.content[0].text).toContain("no mailbox");
    expect(result.isError).toBe(true);
  });

  it("keeps the stack, which is the reason the log exists", async () => {
    const { sink, recorded } = recordingSink();

    await reportingFailures({
      tool: "read_memory",
      args: {},
      login: null,
      sink,
      run: async () => {
        throw new Error("boom");
      },
    });

    expect(recorded[0].stack).toContain("Error: boom");
  });

  it("survives a sink that itself fails", async () => {
    const failingSink: FailureSink = () => {
      throw new Error("the log store is down");
    };

    const result = await reportingFailures({
      tool: "read_memory",
      args: {},
      login: null,
      sink: failingSink,
      run: async () => {
        throw new Error("the original problem");
      },
    });

    // The original failure is what the caller needs; losing it to a
    // logging problem would be worse than not logging at all.
    expect(result).toMatchObject({ isError: true });
    expect((result as { content: [{ text: string }] }).content[0].text).toContain(
      "the original problem",
    );
  });

  it("handles a thrown value that is not an Error", async () => {
    const { sink, recorded } = recordingSink();

    await reportingFailures({
      tool: "read_memory",
      args: {},
      login: null,
      sink,
      run: async () => {
        throw "a bare string";
      },
    });

    expect(recorded[0].message).toBe("a bare string");
    expect(recorded[0].stack).toBeNull();
  });
});

describe("redactArguments", () => {
  it("keeps the keys that make a failure reproducible", () => {
    const redacted = redactArguments({
      path: "other-memory/facts/core.md",
      commit_message: "feat: record something",
    }) as Record<string, unknown>;

    expect(redacted.path).toBe("other-memory/facts/core.md");
    expect(redacted.commit_message).toBe("feat: record something");
  });

  it("does not copy memory content into the failure log", () => {
    const redacted = redactArguments({
      path: "other-memory/facts/core.md",
      text: "Something private the user said about their life.",
    }) as Record<string, unknown>;

    expect(redacted.text).not.toContain("private");
    expect(redacted.text).toContain("redacted");
    expect(redacted.path).toBe("other-memory/facts/core.md");
  });

  it("records how long the redacted value was", () => {
    const redacted = redactArguments({ content: "12345" }) as Record<string, unknown>;

    expect(redacted.content).toBe("[redacted] (5 chars)");
  });
});

describe("buildFailure", () => {
  it("encodes arguments as JSON so they can be stored in one column", () => {
    const failure = buildFailure({
      tool: "read_memory",
      error: new Error("nope"),
      args: { path: "a/b.md" },
      login: "idin",
      timestamp: "2026-08-09T12:00:00.000Z",
    });

    expect(JSON.parse(failure.arguments)).toEqual({ path: "a/b.md" });
    expect(failure.timestamp).toBe("2026-08-09T12:00:00.000Z");
  });

  it("survives arguments that cannot be encoded", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const failure = buildFailure({
      tool: "read_memory",
      error: new Error("nope"),
      args: cyclic,
      login: null,
      timestamp: "2026-08-09T12:00:00.000Z",
    });

    // The failure being reported matters more than the arguments that
    // caused it, so an unencodable argument must not throw in turn.
    expect(failure.message).toBe("nope");
    expect(failure.arguments).toBe('"[unencodable]"');
  });
});

/**
 * When GitHub's rate limit is exhausted, every tool that reads the store
 * fails. On 2026-08-26 that surfaced to the user as a spinner that never
 * resolved, then a raw Octokit message — neither of which says the store is
 * fine and the call should be retried later.
 */
describe("a rate-limited failure explains itself", () => {
  const sink = () => {};

  test("says the store is fine and to retry", async () => {
    const result = await reportingFailures({
      tool: "list_memory_files",
      args: {},
      login: "idin",
      sink,
      run: async () => {
        throw new Error(
          "Request quota exhausted for request GET /repos/{owner}/{repo}/branches/{branch}",
        );
      },
    });

    const text = (result as { content: [{ text: string }] }).content[0].text;
    expect(text).toContain("rate limit");
    // The part that stops an agent reporting an empty memory as the answer.
    expect(text).toContain("Nothing is wrong with the store");
    expect(text).not.toContain("This has been logged");
  });

  test("reports the reset time when GitHub sends one", async () => {
    const resetAt = 1787800000;
    const result = await reportingFailures({
      tool: "read_memory",
      args: {},
      login: "idin",
      sink,
      run: async () => {
        throw Object.assign(new Error("API rate limit exceeded"), {
          response: { headers: { "x-ratelimit-reset": String(resetAt) } },
        });
      },
    });

    const text = (result as { content: [{ text: string }] }).content[0].text;
    expect(text).toContain(new Date(resetAt * 1000).toISOString());
  });

  test("an ordinary failure still reports normally", async () => {
    const result = await reportingFailures({
      tool: "read_memory",
      args: {},
      login: "idin",
      sink,
      run: async () => {
        throw new Error("Not Found");
      },
    });

    const text = (result as { content: [{ text: string }] }).content[0].text;
    expect(text).toContain("This has been logged");
    expect(text).not.toContain("rate limit");
  });
});
