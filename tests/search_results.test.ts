import { describe, expect, test } from "vitest";

import { describeSearchResults } from "../src/search_results";
import type { CascadeResult } from "../src/search_cascade";
import type { ExpandedHit } from "../src/sibling_chunks";
import { chunk } from "./chunk_fixture";

/**
 * What an agent reads. Two properties matter more than formatting, and both
 * are about not misleading the reader.
 *
 * A result must say why it is here, or it will be misused — a fuzzy near-match
 * quoted as an exact one, a semantic neighbour treated as a direct answer.
 *
 * An empty result must say what kind of empty it is. Without semantic search,
 * "canine" finds nothing in a store that says "toy poodle", and reporting that
 * as "not in the store" is a confident wrong answer.
 */

function result(
  overrides: Partial<ExpandedHit<CascadeResult>> = {},
): ExpandedHit<CascadeResult> {
  return {
    chunk: chunk(),
    features: {
      exact: 0,
      startsWith: 0,
      endsWith: 0,
      contains: 1,
      containedBy: 0,
      fuzzy: 1,
      cosine: null,
    },
    tier: "contains",
    cosineSimilarityRank: null,
    fuzzyRank: null,
    matchedBy: ["contains"],
    siblings: [],
    ...overrides,
  };
}

const CONTEXT = {
  query: "poodle",
  semanticAvailable: true,
  searched: [chunk()],
  includeDeep: false,
  indexReason: null,
};

describe("finding nothing", () => {
  test("with semantic search, absence is reported as likely absence", () => {
    const text = describeSearchResults([], CONTEXT);
    expect(text).toContain("Nothing in the store matched");
    expect(text).toContain("most likely does not hold this");
  });

  test("without it, absence is reported as a limit of the search", () => {
    // The distinction that prevents a confident wrong "no". A store holding
    // "toy poodle" returns nothing for "canine" under word matching alone,
    // and that is a fact about the query, not about the store.
    const text = describeSearchResults([], {
      ...CONTEXT,
      semanticAvailable: false,
    });
    expect(text).toContain("no stored wording matched");
    expect(text).toContain("not that the fact is absent");
  });

  test("the query is quoted back", () => {
    expect(describeSearchResults([], CONTEXT)).toContain('"poodle"');
  });

  test("a partial index is reported instead of the usual absence message", () => {
    // The strongest case of "not found does not mean absent": an empty
    // result from an incomplete index may simply be an unindexed file, not
    // a fact the store lacks. This takes priority over the semantic-search
    // caveat, since an incomplete index is the more specific, more
    // actionable explanation.
    const text = describeSearchResults([], {
      ...CONTEXT,
      indexReason: "PARTIAL INDEX: Indexed 12 of 114 files so far.",
    });
    expect(text).toContain("PARTIAL INDEX: Indexed 12 of 114 files so far.");
    expect(text).not.toContain("most likely does not hold this");
  });
});

describe("a result explains itself", () => {
  test("the path and heading are given", () => {
    const text = describeSearchResults(
      [
        result({
          chunk: chunk({
            path: "other-memory/facts/core.md",
            headingPath: ["Core", "Imported (second-hand)"],
          }),
        }),
      ],
      CONTEXT,
    );
    expect(text).toContain("other-memory/facts/core.md");
    expect(text).toContain("Core > Imported (second-hand)");
  });

  test("line numbers are given, so the source can be checked", () => {
    const text = describeSearchResults(
      [result({ chunk: chunk({ startLine: 12, endLine: 20 }) })],
      CONTEXT,
    );
    expect(text).toContain("lines 12-20");
  });

  test("which method matched is named", () => {
    expect(describeSearchResults([result()], CONTEXT)).toContain("contains");
  });

  test("a semantic score is shown when there is one", () => {
    const text = describeSearchResults(
      [
        result({
          features: { ...result().features, cosine: 0.83 },
        }),
      ],
      CONTEXT,
    );
    expect(text).toContain("meaning 0.83");
  });

  test("a match by meaning alone is flagged", () => {
    // Without this, a reader searching the excerpt for their query's words
    // finds nothing and concludes the result is wrong.
    const text = describeSearchResults(
      [result({ tier: "cosine", matchedBy: ["cosine"] })],
      CONTEXT,
    );
    expect(text).toContain("found by meaning alone");
  });
});

describe("superseded content is labelled", () => {
  test("struck-through values are listed as not current", () => {
    const text = describeSearchResults(
      [result({ chunk: chunk({ superseded: ["Mid-40s.", "13-year-old"] }) })],
      CONTEXT,
    );
    expect(text).toContain("superseded here, not current");
    expect(text).toContain("Mid-40s.");
  });

  test("a chunk mixing current and superseded text warns", () => {
    // Where stripping would have gutted the text, nothing was removed — so
    // the excerpt contains both, and quoting it blind would state a
    // superseded fact as current.
    const text = describeSearchResults(
      [result({ chunk: chunk({ containsSuperseded: true }) })],
      CONTEXT,
    );
    expect(text).toContain("mixes current and superseded");
  });
});

describe("siblings are shown as context", () => {
  test("an attached sibling appears with its own location", () => {
    const text = describeSearchResults(
      [
        result({
          chunk: chunk({ ordinal: 1, text: "It moved to TD Bank." }),
          siblings: [
            chunk({
              ordinal: 0,
              text: "The mortgage was refinanced in 2020.",
              startLine: 3,
              endLine: 4,
            }),
          ],
        }),
      ],
      CONTEXT,
    );
    expect(text).toContain("context,");
    expect(text).toContain("The mortgage was refinanced in 2020.");
    expect(text).toContain("lines 3-4");
  });

  test("no siblings means no context section", () => {
    expect(describeSearchResults([result()], CONTEXT)).not.toContain("context,");
  });
});

describe("what was not searched is reported", () => {
  test("lexical-only results say so even when they found something", () => {
    // Results that look complete are the dangerous case: an agent has no
    // reason to doubt them unless told.
    const text = describeSearchResults([result()], {
      ...CONTEXT,
      semanticAvailable: false,
    });
    expect(text).toContain("not the whole answer");
  });

  test("held-back deep files are counted", () => {
    // The existing convention: an agent that does not know the rest exists
    // will answer confidently from a store it could not see all of.
    const text = describeSearchResults([result()], {
      ...CONTEXT,
      searched: [
        chunk({ path: "other-memory/facts/core.md" }),
        chunk({ path: "other-memory/work/todos/resolved/2026-08-12_done.md" }),
        chunk({ path: "other-memory/messages/archive/kip/note.md" }),
      ],
    });
    expect(text).toMatch(/further file/);
  });

  test("nothing is claimed when nothing was held back", () => {
    const text = describeSearchResults([result()], CONTEXT);
    expect(text).not.toMatch(/further file/);
  });

  test("asking for everything reports no withholding", () => {
    const text = describeSearchResults([result()], {
      ...CONTEXT,
      includeDeep: true,
      searched: [
        chunk({ path: "other-memory/facts/core.md" }),
        chunk({ path: "other-memory/work/todos/resolved/2026-08-12_done.md" }),
      ],
    });
    expect(text).not.toMatch(/further file/);
  });
});

describe("a partial index is flagged, not just an empty result", () => {
  test("the caveat appears before the results, not after everything", () => {
    // A caveat only a reader who scrolls to the very end would see is a
    // caveat that gets skipped.
    const text = describeSearchResults([result()], {
      ...CONTEXT,
      indexReason: "PARTIAL INDEX: 3 changed file(s) still to index.",
    });
    const caveatIndex = text.indexOf("PARTIAL INDEX");
    const firstResultIndex = text.indexOf(result().chunk.path);
    expect(caveatIndex).toBeGreaterThan(-1);
    expect(caveatIndex).toBeLessThan(firstResultIndex);
  });

  test("no caveat appears when the index is complete", () => {
    expect(describeSearchResults([result()], CONTEXT)).not.toContain(
      "PARTIAL INDEX",
    );
  });
});
