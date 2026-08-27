import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A Cloudflare Worker may make at most 50 subrequests per invocation.
 *
 * Reading the mistake log one file at a time spends one subrequest per entry,
 * so the cost grows with the log. On 2026-08-27, at 45 entries, the digest
 * needed 47 subrequests and failed outright:
 *
 *     Too many subrequests by single Worker invocation.
 *
 * The failure has a nasty shape — the digest exists to compress a log that has
 * grown, so the tool broke precisely when it became worth running. And
 * `summariseMistakes` runs on every tool call, which put the whole server one
 * call from the same ceiling.
 *
 * The fix reads every entry in a single GraphQL request with aliased Blob
 * objects, so the cost is constant. This is asserted against the source
 * because a per-file loop only fails against a real store large enough to
 * exceed the cap — by which point it is live, and the tool that would tell
 * you is the one that is broken.
 */
describe("reading the mistake log costs a constant number of requests", () => {
  const digest = readFileSync(
    join(import.meta.dirname, "..", "src", "digest.ts"),
    "utf8",
  );
  const mistakes = readFileSync(
    join(import.meta.dirname, "..", "src", "mistakes.ts"),
    "utf8",
  );
  const reader = readFileSync(
    join(import.meta.dirname, "..", "src", "mistake_entries.ts"),
    "utf8",
  );

  test("the digest does not fetch entries one at a time", () => {
    // The exact shape that caused the outage: a getContent inside a loop over
    // the entry paths.
    expect(digest).not.toMatch(/for\s*\([^)]*of\s+paths\s*\)/);
    expect(digest).not.toContain("repos.getContent");
  });

  test("the digest delegates to the shared batched reader", () => {
    expect(digest).toContain("readAllMistakeEntries");
  });

  test("counting entries does not fetch them one at a time", () => {
    // summariseMistakes rides along with every tool response, so a per-file
    // read here costs every tool on the server, not just the digest.
    expect(mistakes).not.toContain("repos.getContent");
    expect(mistakes).not.toContain("Promise.all");
  });

  test("counting entries delegates to the shared batched reader", () => {
    expect(mistakes).toContain("readAllMistakeEntries");
  });

  test("the shared reader batches every entry into one GraphQL request", () => {
    // Two calls total: one listing the folder, one fetching all blobs. Asserted
    // on the reader rather than on its callers, because both callers delegate
    // here — which is the point of the module. A per-file loop would show up as
    // a getContent, and a fixed batch size would only move the ceiling that
    // caused the outage.
    expect(reader).toContain("graphql");
    expect(reader).not.toContain("repos.getContent");
    expect(reader).toMatch(/\.\.\. on Blob/);
  });
});
