/**
 * Failure reporting for MCP tools.
 *
 * When a tool throws, two different readers need something from it, and
 * they need different things. The agent that made the call needs to know
 * the call failed and roughly why, so it can say so rather than inventing
 * a result. Whoever maintains the server needs the stack, the arguments
 * and the time, later, when they sit down to fix it.
 *
 * A thrown exception serves the first reader badly and the second not at
 * all: the MCP transport reduces it to a message, and once the request is
 * over the context is gone. So failures are captured here instead —
 * turned into a record, handed to a sink, and reported back to the caller
 * as an error result rather than an exception.
 */

/** A tool failure, in the form it is stored and read back in. */
export type ToolFailure = {
  /** When the failure happened, ISO 8601. */
  timestamp: string;
  /** Which tool was called. */
  tool: string;
  /** The authenticated caller, when the request had one. */
  login: string | null;
  /**
   * Arguments the tool was called with, JSON-encoded.
   *
   * These are what makes a failure reproducible, and they are also the
   * contents of someone's memory. See {@link redactArguments}.
   */
  arguments: string;
  /** The error message. */
  message: string;
  /** The stack, when the thrown value carried one. */
  stack: string | null;
};

/**
 * Somewhere failures are written.
 *
 * Kept deliberately small so that a deployment can send failures to a
 * database, a log service, or anywhere else, without the library needing
 * to know that such a place exists.
 */
export type FailureSink = (failure: ToolFailure) => void | Promise<void>;

/**
 * Argument keys whose values are never recorded.
 *
 * A failure record is useful because it holds the arguments, and the
 * arguments to a memory server are the memories themselves. Recording
 * the full text of what someone was writing about their life, every time
 * a write fails, quietly turns an error log into a second copy of the
 * thing it is logging about. The key is kept because knowing *which*
 * arguments were present is most of the diagnostic value; the value is
 * replaced because it rarely adds more.
 */
const REDACTED_ARGUMENT_KEYS = new Set([
  "content",
  "text",
  "body",
  "message",
  "entry",
]);

const REDACTED_PLACEHOLDER = "[redacted]";

/** Longest argument blob stored, in characters. */
const MAXIMUM_ARGUMENT_LENGTH = 2000;

/**
 * Replace argument values that should not be duplicated into a log.
 *
 * @param args - Arguments as the tool received them.
 * @returns The same shape, with sensitive values replaced by a
 *   placeholder that records their length.
 */
export function redactArguments(args: unknown): unknown {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return args;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (REDACTED_ARGUMENT_KEYS.has(key) && typeof value === "string") {
      redacted[key] = `${REDACTED_PLACEHOLDER} (${value.length} chars)`;
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

/**
 * Build a failure record from a thrown value.
 *
 * @param options.tool - Name of the tool that failed.
 * @param options.error - Whatever was thrown. Anything can be thrown in
 *   JavaScript, so non-Error values are described rather than assumed.
 * @param options.args - Arguments the tool was called with.
 * @param options.login - Authenticated caller, when there was one.
 * @param options.timestamp - When the failure happened.
 * @returns The record to store.
 */
export function buildFailure(options: {
  tool: string;
  error: unknown;
  args: unknown;
  login: string | null;
  timestamp: string;
}): ToolFailure {
  const { tool, error, args, login, timestamp } = options;
  const isError = error instanceof Error;
  let encodedArguments: string;
  try {
    encodedArguments = JSON.stringify(redactArguments(args)) ?? "null";
  } catch {
    // Arguments arrive from a remote caller and are not guaranteed to be
    // encodable — a cycle here must not mask the failure being reported.
    encodedArguments = '"[unencodable]"';
  }
  return {
    timestamp,
    tool,
    login,
    arguments: encodedArguments.slice(0, MAXIMUM_ARGUMENT_LENGTH),
    message: isError ? error.message : String(error),
    stack: isError ? (error.stack ?? null) : null,
  };
}

/**
 * Write a failure to the console as one structured line.
 *
 * This is the default sink. On Cloudflare it is not a fallback so much as
 * the ordinary path: Workers observability already captures and retains
 * console output, so a deployment that configures nothing still has its
 * failures recorded and searchable.
 *
 * @param failure - The record to write.
 * @returns Nothing.
 */
export const consoleFailureSink: FailureSink = (failure: ToolFailure) => {
  console.error(JSON.stringify({ kind: "tool_failure", ...failure }));
};

/**
 * Whether a failure message is GitHub refusing for rate reasons.
 *
 * Kept here rather than imported from `memory_repo` on purpose: this module
 * is what every tool funnels its errors through, and it must not depend on
 * the module whose calls it is reporting on. `isRateLimited` there decides
 * how long to wait; this decides what to tell the caller.
 *
 * @param message - The failure message.
 * @returns True when the message describes a rate limit.
 */
function isRateLimitMessage(message: string): boolean {
  const lowered = message.toLowerCase();
  return (
    lowered.includes("rate limit")
    || lowered.includes("quota exhausted")
    || lowered.includes("secondary rate")
  );
}

/**
 * Run a tool handler, reporting any failure rather than throwing.
 *
 * @param options.tool - Name of the tool being run.
 * @param options.args - Arguments it was called with.
 * @param options.login - Authenticated caller, when there was one.
 * @param options.sink - Where the failure is written.
 * @param options.run - The handler itself.
 * @returns The handler's result, or an error result describing the
 *   failure.
 */
export async function reportingFailures<Result>(options: {
  tool: string;
  args: unknown;
  login: string | null;
  sink: FailureSink;
  run: () => Promise<Result>;
}): Promise<Result | { content: [{ type: "text"; text: string }]; isError: true }> {
  const { tool, args, login, sink, run } = options;
  try {
    return await run();
  } catch (error) {
    const failure = buildFailure({
      tool,
      error,
      args,
      login,
      timestamp: new Date().toISOString(),
    });
    try {
      await sink(failure);
    } catch (sinkError) {
      // A sink that cannot write must not replace the failure it was
      // asked to record: the original is what the caller needs to hear
      // about, and losing it to a logging problem is the worst outcome.
      console.error(
        JSON.stringify({
          kind: "failure_sink_error",
          tool,
          message: sinkError instanceof Error ? sinkError.message : String(sinkError),
        }),
      );
    }
    // A rate limit is not a bug in the call, and saying so stops an agent
    // retrying into the wall or reporting an empty store as an answer. The
    // reset time is the one fact that makes the message actionable.
    const rateLimitReset = (error as { response?: { headers?: Record<string, string> } })
      ?.response?.headers?.["x-ratelimit-reset"];
    const resetNote = rateLimitReset
      ? ` The limit resets at ${new Date(Number(rateLimitReset) * 1000).toISOString()}.`
      : "";
    const explanation = isRateLimitMessage(failure.message)
      ? `The ${tool} tool could not run: GitHub's API rate limit is `
        + `exhausted, so the memory could not be read.${resetNote} Nothing is `
        + "wrong with the store — tell the user to try again after the reset, "
        + "and do not treat this as an empty or missing result."
      : `The ${tool} tool failed: ${failure.message}\n\n`
        + "This has been logged. Tell the user the call failed rather than "
        + "treating the absence of a result as an answer.";

    return {
      content: [{ type: "text" as const, text: explanation }],
      isError: true,
    };
  }
}
