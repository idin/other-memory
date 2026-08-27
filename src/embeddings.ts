/**
 * Turning text into vectors, and comparing them.
 *
 * This is the half of search that reaches meaning rather than spelling. Run
 * against the real store, a search for "canine" returns nothing about the toy
 * poodle — no lexical method has a path from one word to the other, and the
 * empty result reads as "not in the store" rather than "asked the wrong way".
 * That failure is silent, which is what makes it worth the infrastructure.
 *
 * Two hazards here are silent in the same way, and both are guarded:
 * truncation above the model's token limit, and comparing vectors that came
 * from different models or pooling modes.
 */

import {
  EMBEDDING_MODEL_TOKEN_LIMIT,
  chunkSearchText,
  estimateTokens,
  type MemoryChunk,
} from "./chunking";
import {
  NEURONS_PER_MILLION_TOKENS_BGE_BASE,
  estimateUsage,
  type ApiUsage,
  type UsageSink,
} from "./api_usage";

/**
 * The model vectors are computed with.
 *
 * 768 dimensions, 512 input tokens, and free at this store's size — a full
 * rebuild costs roughly 900 neurons against a 10,000-per-day allowance.
 */
export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

/** How many numbers a vector from that model has. */
export const EMBEDDING_DIMENSIONS = 768;

/**
 * How vectors are pooled from the model's token outputs.
 *
 * `cls` is Cloudflare's recommendation and produces better vectors on longer
 * inputs. Their documentation is explicit that cls and mean embeddings "are
 * not compatible" — the default is `mean` only because changing it would have
 * broken existing indexes.
 *
 * Recorded alongside every stored vector, because comparing across pooling
 * modes returns a plausible number rather than an error.
 */
export const EMBEDDING_POOLING = "cls";

/**
 * How many texts go in one call.
 *
 * The model's documented maximum. Exceeding it is an error rather than a
 * silent truncation, but batching to the limit means the whole store embeds
 * in four calls rather than 382.
 */
export const EMBEDDING_BATCH_SIZE = 100;

/** What the characters-per-token estimate assumes, for usage accounting. */
const CHARACTERS_PER_TOKEN_ESTIMATE = 4;

/** Something that turns texts into vectors. */
export type Embedder = (texts: string[]) => Promise<Float32Array[]>;

/** The Workers AI binding, narrowed to what is used here. */
export type WorkersAi = {
  run(
    model: string,
    inputs: { text: string[]; pooling?: string },
  ): Promise<{ data?: number[][] }>;
};

/**
 * Thrown when text would be silently truncated.
 *
 * The model drops everything past its token limit without an error, so a
 * vector comes back looking normal while representing only the first part of
 * the text. Anything in the tail becomes unfindable by semantic search, and
 * nothing reports it. Loud beats silent.
 */
export class TextTooLongToEmbedError extends Error {
  constructor(tokens: number, preview: string) {
    super(
      `Text of about ${tokens} tokens exceeds the model's `
        + `${EMBEDDING_MODEL_TOKEN_LIMIT}-token limit and would be silently `
        + `truncated: "${preview}". Chunk it further before embedding.`,
    );
    this.name = "TextTooLongToEmbedError";
  }
}

/**
 * Build an embedder over the Workers AI binding.
 *
 * @param ai - The bound Workers AI namespace.
 * @param options.usageSink - Where consumption is recorded.
 * @param options.trigger - What caused these calls, for attribution.
 * @param options.now - Clock, injected so timestamps are testable.
 * @returns A function from texts to vectors.
 */
export function workersAiEmbedder(
  ai: WorkersAi,
  options: { usageSink: UsageSink; trigger: string; now: () => number },
): Embedder {
  return async (texts: string[]) => {
    for (const text of texts) {
      const tokens = estimateTokens(text);
      if (tokens > EMBEDDING_MODEL_TOKEN_LIMIT) {
        throw new TextTooLongToEmbedError(tokens, text.slice(0, 60));
      }
    }

    const vectors: Float32Array[] = [];
    let calls = 0;
    let characters = 0;

    for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
      const batch = texts.slice(start, start + EMBEDDING_BATCH_SIZE);
      const response = await ai.run(EMBEDDING_MODEL, {
        text: batch,
        pooling: EMBEDDING_POOLING,
      });
      const data = response.data ?? [];
      if (data.length !== batch.length) {
        throw new Error(
          `Asked for ${batch.length} embeddings and got ${data.length}. `
            + "Indexing on a short response would leave chunks silently "
            + "unsearchable.",
        );
      }
      for (const row of data) {
        vectors.push(new Float32Array(row));
      }
      calls += 1;
      characters += batch.reduce((total, text) => total + text.length, 0);
    }

    // Recorded as an estimate because the embedding response carries no usage
    // object — no token count, no neuron count. Calls, items and characters
    // are counted; everything else here is derived and named to say so.
    const estimated = estimateUsage(characters, {
      neuronsPerMillionTokens: NEURONS_PER_MILLION_TOKENS_BGE_BASE,
      charactersPerToken: CHARACTERS_PER_TOKEN_ESTIMATE,
    });
    const usage: ApiUsage = {
      timestamp: new Date(options.now()).toISOString(),
      service: "workers_ai",
      model: EMBEDDING_MODEL,
      operation: "embed",
      trigger: options.trigger,
      calls,
      items: texts.length,
      characters,
      estimatedTokens: estimated.estimatedTokens,
      estimatedUnits: estimated.estimatedUnits,
      unitName: "neurons",
    };
    await options.usageSink(usage);

    return vectors;
  };
}

/**
 * Credentials for reaching Workers AI without a binding.
 *
 * A binding only exists inside the Worker runtime, which makes anything built
 * on it unrunnable from a terminal or a plain test — and the embedding is the
 * one number this whole design rests on. Reaching the same models over their
 * REST API keeps every part of what the server does executable anywhere.
 */
export type WorkersAiCredentials = {
  accountId: string;
  apiToken: string;
};

/**
 * Build an embedder that calls Workers AI over HTTP.
 *
 * The same model and pooling as the binding-backed embedder, so vectors from
 * the two are comparable and an index built by one can be queried by the
 * other. That equivalence is what makes it a real alternative rather than an
 * approximation for testing.
 *
 * @param credentials - Account and token with Workers AI access.
 * @param options.usageSink - Where consumption is recorded.
 * @param options.trigger - What caused these calls, for attribution.
 * @param options.now - Clock, injected so timestamps are testable.
 * @returns A function from texts to vectors.
 */
export function restWorkersAiEmbedder(
  credentials: WorkersAiCredentials,
  options: { usageSink: UsageSink; trigger: string; now: () => number },
): Embedder {
  const ai: WorkersAi = {
    async run(model: string, inputs: { text: string[]; pooling?: string }) {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}`
          + `/ai/run/${model}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${credentials.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(inputs),
        },
      );

      if (!response.ok) {
        throw new Error(
          `Workers AI returned ${response.status}: ${await response.text()}`,
        );
      }

      // The REST API wraps what the binding returns directly, so unwrapping
      // here keeps both paths returning the same shape to their caller.
      const body = (await response.json()) as {
        result?: { data?: number[][] };
        success?: boolean;
        errors?: { message?: string }[];
      };

      if (body.success === false) {
        const reasons = (body.errors ?? [])
          .map((error) => error.message ?? "unknown")
          .join("; ");
        throw new Error(`Workers AI reported failure: ${reasons}`);
      }

      return { data: body.result?.data };
    },
  };

  return workersAiEmbedder(ai, options);
}

/**
 * Cosine similarity between two vectors.
 *
 * Note what this cannot tell you: two vectors from different models, or from
 * different pooling modes, produce a number here rather than an error. The
 * number is meaningless. Guarding that is the index's job, which is why model
 * and pooling are part of its identity.
 *
 * @param first - One vector.
 * @param second - The other, of the same length.
 * @returns Similarity, normally in [-1, 1].
 */
export function cosineSimilarity(
  first: Float32Array,
  second: Float32Array,
): number {
  if (first.length !== second.length) {
    throw new Error(
      `Cannot compare a ${first.length}-dimension vector with a `
        + `${second.length}-dimension one. They came from different models.`,
    );
  }

  let dot = 0;
  let firstMagnitude = 0;
  let secondMagnitude = 0;
  for (let index = 0; index < first.length; index += 1) {
    dot += first[index] * second[index];
    firstMagnitude += first[index] * first[index];
    secondMagnitude += second[index] * second[index];
  }

  const divisor = Math.sqrt(firstMagnitude) * Math.sqrt(secondMagnitude);
  return divisor === 0 ? 0 : dot / divisor;
}

/** A chunk and how close it is to the query, semantically. */
export type SemanticHit = {
  chunk: MemoryChunk;
  similarity: number;
};

/**
 * Rank chunks by how close their meaning is to a query vector.
 *
 * Brute force over every vector, deliberately. At a few hundred chunks this
 * is sub-millisecond, and a vector database would add a binding, a network
 * hop, an eventual-consistency window between rebuild and query, and a second
 * store to invalidate. Worth revisiting around a hundred thousand chunks.
 *
 * @param indexed - Chunks with their vectors. Those without are skipped.
 * @param queryVector - The query, embedded.
 * @param options.limit - How many to return.
 * @returns Hits, closest first.
 */
export function searchSemantically(
  indexed: { chunk: MemoryChunk; vector: Float32Array | null }[],
  queryVector: Float32Array,
  options: { limit: number },
): SemanticHit[] {
  const hits: SemanticHit[] = [];
  for (const { chunk, vector } of indexed) {
    if (!vector) {
      continue;
    }
    hits.push({ chunk, similarity: cosineSimilarity(vector, queryVector) });
  }
  return hits
    .sort((first, second) => second.similarity - first.similarity)
    .slice(0, options.limit);
}

/**
 * Embed the text of chunks, in batches.
 *
 * @param chunks - What to embed.
 * @param embed - The embedder.
 * @returns The same chunks, each with its vector.
 */
export async function embedChunks(
  chunks: MemoryChunk[],
  embed: Embedder,
): Promise<{ chunk: MemoryChunk; vector: Float32Array }[]> {
  if (chunks.length === 0) {
    return [];
  }
  // Embedded with heading ancestry and preamble included, so the vector
  // carries the context the chunk sits in — a section under "Imported
  // (second-hand)" should be findable by that phrase.
  const vectors = await embed(chunks.map((chunk) => chunkSearchText(chunk)));
  return chunks.map((chunk, index) => ({ chunk, vector: vectors[index] }));
}

/**
 * Whether an error means the embedding service is refusing work rather than
 * the request being wrong.
 *
 * A quota that has run out, a rate limit, a service that is down: none of
 * these say anything about the text handed over, and all of them are
 * temporary. The distinction matters because the response differs — an
 * unavailable embedder means fall back to lexical search and say so, while a
 * text that cannot be embedded is a bug worth surfacing.
 *
 * Matched on the message because Workers AI reports these as a plain `Error`
 * carrying a numeric code, with no typed class to catch. 4006 is the daily
 * neuron allowance; the rest are matched by wording.
 *
 * @param error - Whatever was thrown.
 * @returns True when the embedder is unavailable rather than misused.
 */
export function isEmbedderUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("4006")
    || message.includes("daily free allocation")
    || message.includes("capacity temporarily exceeded")
    || message.includes("rate limit")
    || message.includes("too many requests")
  );
}

/**
 * Embed what can be embedded, and report it when nothing can.
 *
 * The whole point of the vectors is that an empty result reads as "not
 * recorded" rather than "asked using different words", so losing them
 * degrades search. Losing the *server* is worse: an exhausted quota used to
 * escape as an exception and take down the connection that was trying to
 * rebuild the index, which made an optional feature able to break a
 * deployment that never asked for it.
 *
 * So an unavailable embedder returns chunks with no vectors and a reason to
 * show the caller. Anything else still throws — a text that cannot be
 * embedded is a bug, not a fallback.
 *
 * @param chunks - What to embed.
 * @param embed - The embedder, or null when the deployment has none.
 * @returns The chunks with vectors where possible, and why not when absent.
 */
export async function embedChunksOrExplain(
  chunks: MemoryChunk[],
  embed: Embedder | null,
): Promise<{
  embedded: { chunk: MemoryChunk; vector: Float32Array | null }[];
  unavailable: string | null;
}> {
  if (!embed) {
    return {
      embedded: chunks.map((chunk) => ({ chunk, vector: null })),
      unavailable: null,
    };
  }
  try {
    return { embedded: await embedChunks(chunks, embed), unavailable: null };
  } catch (error) {
    if (!isEmbedderUnavailable(error)) {
      throw error;
    }
    return {
      embedded: chunks.map((chunk) => ({ chunk, vector: null })),
      unavailable: error instanceof Error ? error.message : String(error),
    };
  }
}
