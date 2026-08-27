import { describe, expect, test } from "vitest";

import {
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_POOLING,
  TextTooLongToEmbedError,
  cosineSimilarity,
  embedChunks,
  embedChunksOrExplain,
  isEmbedderUnavailable,
  searchSemantically,
  workersAiEmbedder,
  type WorkersAi,
} from "../src/embeddings";
import type { ApiUsage } from "../src/api_usage";
import { chunk } from "./chunk_fixture";

/**
 * Embeddings exist because lexical search cannot get from "canine" to "dog",
 * and its failure is silent — an empty result reads as "not in the store"
 * rather than "asked the wrong way".
 *
 * The hazards here are silent in the same way, so they are what these tests
 * are mostly about: truncation above the token limit, and comparing vectors
 * that came from different models.
 */

/** A stand-in for Workers AI, returning deterministic vectors. */
function fakeAi(options: { dimensions?: number } = {}): WorkersAi & {
  calls: { text: string[]; pooling?: string }[];
} {
  const calls: { text: string[]; pooling?: string }[] = [];
  return {
    calls,
    async run(_model, inputs) {
      calls.push(inputs);
      return {
        data: inputs.text.map((text) =>
          Array.from(
            { length: options.dimensions ?? EMBEDDING_DIMENSIONS },
            (_unused, index) => (text.length + index) / 1000,
          ),
        ),
      };
    },
  };
}

const NO_USAGE = { usageSink: () => {}, trigger: "test", now: () => 0 };

describe("cosineSimilarity", () => {
  test("identical vectors score 1", () => {
    const vector = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(vector, vector)).toBeCloseTo(1, 6);
  });

  test("opposite vectors score -1", () => {
    expect(
      cosineSimilarity(new Float32Array([1, 0]), new Float32Array([-1, 0])),
    ).toBeCloseTo(-1, 6);
  });

  test("perpendicular vectors score 0", () => {
    expect(
      cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1])),
    ).toBeCloseTo(0, 6);
  });

  test("magnitude does not matter, only direction", () => {
    expect(
      cosineSimilarity(new Float32Array([1, 1]), new Float32Array([10, 10])),
    ).toBeCloseTo(1, 6);
  });

  test("a zero vector scores 0 rather than dividing by zero", () => {
    expect(
      cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1])),
    ).toBe(0);
  });

  test("vectors of different lengths throw", () => {
    // Different lengths mean different models. Returning a number would be
    // worse than failing, because the number looks like an answer.
    expect(() =>
      cosineSimilarity(new Float32Array(768), new Float32Array(384)),
    ).toThrow(/different models/);
  });
});

describe("truncation is refused, not tolerated", () => {
  test("text past the token limit throws", async () => {
    // The model drops everything past 512 tokens with no error, so the vector
    // comes back looking normal while representing only the beginning.
    // Anything in the tail becomes unfindable and nothing reports it.
    const embed = workersAiEmbedder(fakeAi(), NO_USAGE);
    await expect(embed(["word ".repeat(1000)])).rejects.toThrow(
      TextTooLongToEmbedError,
    );
  });

  test("the error says what to do about it", async () => {
    const embed = workersAiEmbedder(fakeAi(), NO_USAGE);
    await expect(embed(["word ".repeat(1000)])).rejects.toThrow(/Chunk it/);
  });

  test("text within the limit is embedded", async () => {
    const embed = workersAiEmbedder(fakeAi(), NO_USAGE);
    expect(await embed(["Idin has a toy poodle."])).toHaveLength(1);
  });
});

describe("calling the model", () => {
  test("the pooling mode is sent explicitly", async () => {
    // The default is "mean" and Cloudflare recommends "cls". Leaving it
    // implicit would silently pick the worse one, and the two are not
    // comparable.
    const ai = fakeAi();
    await workersAiEmbedder(ai, NO_USAGE)(["text"]);
    expect(ai.calls[0].pooling).toBe(EMBEDDING_POOLING);
  });

  test("texts are batched to the model's maximum", async () => {
    const ai = fakeAi();
    const texts = Array.from({ length: 250 }, (_unused, i) => `text ${i}`);
    const vectors = await workersAiEmbedder(ai, NO_USAGE)(texts);
    expect(vectors).toHaveLength(250);
    expect(ai.calls).toHaveLength(3);
    expect(ai.calls[0].text).toHaveLength(EMBEDDING_BATCH_SIZE);
  });

  test("a short response throws rather than indexing a gap", async () => {
    // Fewer vectors than texts would leave chunks silently unsearchable,
    // which looks exactly like a store that does not contain them.
    const ai: WorkersAi = {
      async run() {
        return { data: [[1, 2, 3]] };
      },
    };
    await expect(
      workersAiEmbedder(ai, NO_USAGE)(["one", "two"]),
    ).rejects.toThrow(/Asked for 2 embeddings and got 1/);
  });

  test("nothing to embed makes no calls", async () => {
    const ai = fakeAi();
    await embedChunks([], workersAiEmbedder(ai, NO_USAGE));
    expect(ai.calls).toEqual([]);
  });
});

describe("usage is recorded", () => {
  test("one record per embedder call, with what it cost", async () => {
    const recorded: ApiUsage[] = [];
    const embed = workersAiEmbedder(fakeAi(), {
      usageSink: (usage) => {
        recorded.push(usage);
      },
      trigger: "full_build",
      now: () => Date.parse("2026-08-14T12:00:00.000Z"),
    });

    await embed(["Idin has a toy poodle.", "Frodo was born 2013-05-06."]);

    expect(recorded).toHaveLength(1);
    expect(recorded[0].items).toBe(2);
    expect(recorded[0].calls).toBe(1);
    expect(recorded[0].unitName).toBe("neurons");
  });

  test("the trigger is carried through, so a spike can be attributed", async () => {
    const recorded: ApiUsage[] = [];
    await workersAiEmbedder(fakeAi(), {
      usageSink: (usage) => {
        recorded.push(usage);
      },
      trigger: "query",
      now: () => 0,
    })(["poodle"]);
    expect(recorded[0].trigger).toBe("query");
  });

  test("characters are measured, tokens are estimated", async () => {
    // The response carries no usage object, so the token figure is derived
    // and named to say so.
    const recorded: ApiUsage[] = [];
    await workersAiEmbedder(fakeAi(), {
      usageSink: (usage) => {
        recorded.push(usage);
      },
      trigger: "test",
      now: () => 0,
    })(["12345678"]);
    expect(recorded[0].characters).toBe(8);
    expect(recorded[0].estimatedTokens).toBe(2);
  });
});

describe("searchSemantically", () => {
  const query = new Float32Array([1, 0, 0]);
  const indexed = [
    { chunk: chunk({ ordinal: 0, text: "close" }), vector: new Float32Array([1, 0.1, 0]) },
    { chunk: chunk({ ordinal: 1, text: "far" }), vector: new Float32Array([0, 1, 0]) },
    { chunk: chunk({ ordinal: 2, text: "middling" }), vector: new Float32Array([0.7, 0.7, 0]) },
  ];

  test("closest first", () => {
    const hits = searchSemantically(indexed, query, { limit: 10 });
    expect(hits.map((hit) => hit.chunk.text)).toEqual([
      "close",
      "middling",
      "far",
    ]);
  });

  test("the limit is respected", () => {
    expect(searchSemantically(indexed, query, { limit: 1 })).toHaveLength(1);
  });

  test("chunks without vectors are skipped, not scored as zero", () => {
    // A chunk stored but not yet embedded is unknown, not distant. Scoring it
    // zero would rank it above genuinely opposite matches.
    const withGap = [...indexed, { chunk: chunk({ ordinal: 3 }), vector: null }];
    expect(searchSemantically(withGap, query, { limit: 10 })).toHaveLength(3);
  });

  test("an empty index returns nothing rather than throwing", () => {
    expect(searchSemantically([], query, { limit: 10 })).toEqual([]);
  });
});

describe("embedChunks", () => {
  test("every chunk gets a vector", async () => {
    const chunks = [chunk({ ordinal: 0 }), chunk({ ordinal: 1 })];
    const embedded = await embedChunks(chunks, workersAiEmbedder(fakeAi(), NO_USAGE));
    expect(embedded).toHaveLength(2);
    expect(embedded[0].vector).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  test("heading ancestry is embedded with the chunk", async () => {
    // So a section under "Imported (second-hand)" is findable by that phrase,
    // and so its vector carries the context it sits in.
    const ai = fakeAi();
    await embedChunks(
      [chunk({ headingPath: ["Core", "Imported (second-hand)"] })],
      workersAiEmbedder(ai, NO_USAGE),
    );
    expect(ai.calls[0].text[0]).toContain("second-hand");
  });
});

/**
 * A deployment ran out of its daily Workers AI allowance mid-rebuild on
 * 2026-08-26. The quota error escaped as an exception, took down the MCP
 * connection, and every client reported only that the server "returned an
 * error when connecting" — an optional feature breaking a deployment that
 * had not asked for it.
 *
 * Embedding is meant to degrade to lexical search and say so. These tests
 * pin that: refusal by the service is a fallback, refusal of the text is a
 * bug and still throws.
 */
describe("an embedder that refuses work", () => {
  const QUOTA_ERROR = new Error(
    "AiError: 4006: you have used up your daily free allocation of 10,000 "
      + "neurons, please upgrade to Cloudflare's Workers Paid plan if you "
      + "would like to continue usage.",
  );

  test("the daily allowance running out is recognised as unavailable", () => {
    expect(isEmbedderUnavailable(QUOTA_ERROR)).toBe(true);
  });

  test("a rate limit is recognised as unavailable", () => {
    expect(isEmbedderUnavailable(new Error("Rate limit exceeded"))).toBe(true);
  });

  test("a text that cannot be embedded is not unavailability", () => {
    // The distinction the whole guard rests on: this one is a bug and must
    // keep throwing rather than silently producing an unsearchable store.
    expect(isEmbedderUnavailable(new TextTooLongToEmbedError(9000, "x"))).toBe(
      false,
    );
  });

  test("chunks come back without vectors, and with the reason", async () => {
    const { embedded, unavailable } = await embedChunksOrExplain(
      [chunk({ text: "a toy poodle called Frodo" })],
      async () => {
        throw QUOTA_ERROR;
      },
    );

    expect(embedded).toHaveLength(1);
    expect(embedded[0].vector).toBeNull();
    // Without this the caller cannot tell a store that holds nothing from one
    // it could not search properly.
    expect(unavailable).toContain("daily free allocation");
  });

  test("an error that is not unavailability still throws", async () => {
    await expect(
      embedChunksOrExplain([chunk({ text: "anything" })], async () => {
        throw new TextTooLongToEmbedError(9000, "anything");
      }),
    ).rejects.toThrow(TextTooLongToEmbedError);
  });

  test("no embedder at all is not an error", async () => {
    const { embedded, unavailable } = await embedChunksOrExplain(
      [chunk({ text: "a toy poodle" })],
      null,
    );
    expect(embedded[0].vector).toBeNull();
    expect(unavailable).toBeNull();
  });
});
