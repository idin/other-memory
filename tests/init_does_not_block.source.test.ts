import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `init()` runs inside the Durable Object's `blockConcurrencyWhile()`, so
 * anything awaited there delays every tool call on the connection — and work
 * long enough to exceed the wall clock gets the object cancelled and reset.
 *
 * On 2026-08-26 a layout change invalidated the search index. The rebuild it
 * triggered was awaited in `init()`, and every client began failing with:
 *
 *     exceededWallTime
 *     A call to blockConcurrencyWhile() in a Durable Object waited for too
 *     long. The call was canceled and the Durable Object was reset.
 *
 * A server that cannot be connected to is worse than one whose search is
 * briefly lexical, and the alarm already does this work on its own. This is
 * asserted against the source because the failure only appears against a
 * real Durable Object under a real wall clock — by which point it is live.
 */
describe("init does not await the index build", () => {
  const source = readFileSync(
    join(import.meta.dirname, "..", "src", "index.ts"),
    "utf8",
  );

  test("continueIndexBuild is scheduled, never awaited in init", () => {
    // The exact shape that caused the outage.
    expect(source).not.toContain("await this.continueIndexBuild()");
  });

  test("init schedules the build instead", () => {
    expect(source).toContain('this.schedule(0, "continueIndexBuild"');
  });

  test("the scheduled build is idempotent", () => {
    // Without this, every Durable Object restart adds another scheduled row,
    // so several builds run at once — each reading the whole store from
    // GitHub. That exhausted the API rate limit within an hour of the
    // scheduling change being introduced.
    const call = source.slice(
      source.indexOf('this.schedule(0, "continueIndexBuild"'),
      source.indexOf('this.schedule(0, "continueIndexBuild"') + 200,
    );
    expect(call).toContain("idempotent: true");
  });

  test("continueIndexBuild swallows its own failures", () => {
    // It runs from an alarm, where a throw means the alarm retries. A build
    // failing for a durable reason would otherwise retry forever.
    const body = source.slice(
      source.indexOf("async continueIndexBuild"),
      source.indexOf("async continueIndexBuild") + 1200,
    );
    expect(body).toContain("try {");
    expect(body).toContain("catch");
    expect(body).toContain("failureSink");
  });
});
