import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The `octokit` package bundles the retry and throttling plugins and turns
 * them on by default. Faced with a rate limit they wait for the reset —
 * up to an hour — rather than returning an error.
 *
 * Inside a Worker that is a hang: the request never finishes, the gateway
 * answers 504, and the client retries into another request that will also
 * wait. On 2026-08-26 that drained a 5000-request quota twice over and made
 * every tool time out, while the server's own rate-limit backoff never ran,
 * because the error it keys on was swallowed a layer below it.
 *
 * Asserted at source level: the behaviour only appears against the real
 * GitHub API with an exhausted quota, which is not a state a test can ask
 * for politely.
 */
describe("every GitHub client fails fast", () => {
  const sourceDirectory = join(import.meta.dirname, "..", "src");

  const sources = readdirSync(sourceDirectory)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(join(sourceDirectory, name), "utf8") }));

  test("nothing constructs Octokit directly", () => {
    // One place owns the options, so they cannot drift per call site.
    const offenders = sources
      .filter(({ name }) => name !== "github_client.ts")
      .filter(({ text }) => text.includes("new Octokit("))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  test("the shared client disables retry and throttling waits", () => {
    const client = sources.find(({ name }) => name === "github_client.ts");
    expect(client).toBeDefined();
    expect(client!.text).toContain("retry: { enabled: false }");
    expect(client!.text).toContain("onRateLimit: () => false");
    expect(client!.text).toContain("onSecondaryRateLimit: () => false");
  });
});
