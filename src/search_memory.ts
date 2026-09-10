/**
 * Running a search, end to end.
 *
 * Everything the search does is in the modules this composes; what lives here
 * is the order they run in and the decisions that order encodes.
 *
 * The index is brought up to date first, because a search against a stale
 * index answers a question about the past without saying so. Selection happens
 * before sibling expansion, so a neighbour's text cannot pull in a chunk that
 * did not itself match.
 *
 * Nothing here ranks results against each other across methods. Recall is the
 * goal: precision is recoverable by whoever reads the results, and recall is
 * not recoverable by anyone, since nothing downstream can retrieve what was
 * never returned. Selection is a per-method cascade — see search_cascade.ts.
 */

import {
  EMBEDDING_MODEL_TOKEN_LIMIT,
  chunkFile,
  chunkSearchText,
  type MemoryChunk,
} from "./chunking";
import {
  EMBEDDING_MODEL,
  EMBEDDING_POOLING,
  embedChunksOrExplain,
  isEmbedderUnavailable,
  searchSemantically,
  type Embedder,
  type SemanticHit,
} from "./embeddings";
import { applyDepth } from "./deep_memory";
import { cascadeResults, type CascadeResult } from "./search_cascade";
import {
  FILES_INDEXED_PER_SEARCH,
  MAXIMUM_SIBLINGS_PER_HIT,
  cosinePoolSize,
  type SearchQuotas,
} from "./search_config";
import {
  planRebuild,
  readHeadCommit,
  type RebuildMode,
} from "./index_rebuild";
import { searchLexically, type LexicalHit } from "./lexical_search";
import type { MemoryRepoConfig } from "./memory_repo";
import {
  hasPersistentMemoryIndex,
  type MemoryIndex,
  type MemoryIndexChunk,
  type MemoryIndexIdentity,
} from "./memory_index";
import { attachSiblings } from "./sibling_chunks";
import type { ExpandedHit } from "./sibling_chunks";
import {
  listStoreTree,
  readStoreBlobs,
  readWholeStore,
  type StoreFileWithSha,
} from "./store_read";

/** Resolved work is left out unless asked for, as everywhere else. */
export const DEFAULT_INCLUDE_DEEP = false;

/**
 * Marks an index reason that means "results below may be incomplete",
 * distinct from an informational reason such as "Index complete: N files."
 * that is also non-null but not a caveat. Callers that decide whether to
 * flag a response can check for this prefix rather than re-deriving
 * completeness from `indexMode` alone, which drops incremental partial
 * builds on the floor — they keep `mode: "incremental"` the same as a
 * complete one.
 */
export const PARTIAL_INDEX_PREFIX = "PARTIAL INDEX: ";

/**
 * Marks an index reason that means "the index is built, but one or more
 * chunks could not be embedded and are searchable by wording only".
 *
 * Deliberately not `PARTIAL_INDEX_PREFIX`: an oversized chunk is not
 * unfinished work. Retrying embeds it again and it fails again — the fix is in
 * the chunker, not another pass. So `buildProgress` must treat a build
 * carrying only this note as complete, or the alarm reschedules itself
 * forever, re-embedding the same doomed chunk every time. It is still a
 * caveat on the results, so callers that flag partial responses check for it
 * too.
 */
export const DEGRADED_INDEX_PREFIX = "DEGRADED INDEX: ";

/**
 * List the store, then fetch text for only a bounded slice of it.
 *
 * Listing is one or two requests regardless of store size; fetching text is
 * what scales per file. Filtering and slicing before fetching is what keeps a
 * batched rebuild's subrequest count bounded by the batch size rather than by
 * the size of the store.
 *
 * @param config - Where the memory lives.
 * @param options.exclude - Paths to leave out before slicing, e.g. what a
 *   resumed build has already indexed.
 * @param options.limit - How many files this batch may fetch.
 * @returns The batch's files with text, and how many eligible files remained
 *   beyond it.
 */
async function readBoundedBatch(
  config: MemoryRepoConfig,
  options: { exclude: Set<string>; limit: number },
): Promise<{ batch: StoreFileWithSha[]; totalEligible: number }> {
  const refs = await listStoreTree(config);
  const eligible = refs.filter((ref) => !options.exclude.has(ref.path));
  const batchRefs = eligible.slice(0, options.limit);
  const batch = await readStoreBlobs(config, batchRefs);
  return { batch, totalEligible: eligible.length };
}

export type SearchOptions = {
  query: string;
  /** How many results each tier of the cascade may contribute. */
  quotas: SearchQuotas;
  includeDeep: boolean;
};

/**
 * Every candidate a search produced, before the cascade cuts it down by
 * quota — the round that includes every fuzzy match, every exact match,
 * everything, not just what a caller ends up seeing.
 *
 * Exists so what the cascade discarded is inspectable, not just what it
 * kept. A quota deciding correctly is not the same claim as a quota
 * deciding on the right candidates, and the second claim needs the first
 * round on record to check.
 */
export type RawSearchRound = {
  query: string;
  /** Every chunk searched, whether or not any method matched it. */
  chunksSearched: number;
  /** Every lexical candidate, whatever scored above zero on any method. */
  lexical: LexicalHit[];
  /** Every semantic candidate within the pool searchSemantically returned. */
  semantic: SemanticHit[];
};

/** Where a raw search round is recorded, before the cascade acts on it. */
export type RawSearchSink = (round: RawSearchRound) => Promise<void>;

/** The sink used when a deployment supplies none. Discards. */
export const noOpRawSearchSink: RawSearchSink = async () => {};

export type SearchOutcome = {
  results: ExpandedHit<CascadeResult>[];
  /** Every chunk searched, for reporting what was held back. */
  searched: MemoryChunk[];
  semanticAvailable: boolean;
  /** What the index had to do to answer this. */
  indexMode: RebuildMode;
  /** Why a full rebuild happened, when one did. */
  indexReason: string | null;
};

/**
 * Bring the index up to date and return every chunk in it.
 *
 * Falls back to reading and chunking the store in memory when no index is
 * configured, so search works without a database — lexically, since there is
 * nowhere to keep vectors.
 */
async function currentChunks(
  config: MemoryRepoConfig,
  index: MemoryIndex,
  embed: Embedder | null,
): Promise<{
  indexed: MemoryIndexChunk[];
  mode: RebuildMode;
  reason: string | null;
}> {
  if (!hasPersistentMemoryIndex(index)) {
    const files = await readWholeStore(config);
    return {
      indexed: files
        .flatMap((file) => chunkFile(file))
        .map((chunk) => ({ chunk, vector: null })),
      mode: "full",
      reason: "No index is configured, so the store was read directly.",
    };
  }

  const headSha = await readHeadCommit(config);
  const identity: MemoryIndexIdentity = {
    commitSha: headSha,
    model: EMBEDDING_MODEL,
    pooling: EMBEDDING_POOLING,
  };
  const builtSha = await index.builtCommit({
    model: EMBEDDING_MODEL,
    pooling: EMBEDDING_POOLING,
  });
  const plan = await planRebuild(
    config,
    builtSha,
    headSha,
    index.maxCarryForwardExclusions,
  );

  if (plan.mode === "up_to_date") {
    return { indexed: await index.load(identity), mode: plan.mode, reason: null };
  }

  if (plan.mode === "full") {
    // What is already indexed at this commit, so a resumed build picks up
    // where the previous search stopped rather than starting again.
    const alreadyIndexed = new Set(
      (await index.load(identity)).map((entry) => entry.chunk.path),
    );
    const { batch, totalEligible } = await readBoundedBatch(config, {
      exclude: alreadyIndexed,
      limit: FILES_INDEXED_PER_SEARCH,
    });

    const oversizedThisRound: string[] = [];
    for (const file of batch) {
      const chunks = chunkFile(file);
      const { embedded, unavailable, oversized } = await embedChunksOrExplain(
        chunks,
        embed,
      );
      recordOversized(oversized, oversizedThisRound);
      if (unavailable) {
        // Store what was read without vectors and stop embedding for this
        // round. Continuing would spend a call per file to be refused each
        // time, and the files already written stay indexed lexically.
        await index.replaceFile(identity, file.path, embedded);
        return {
          indexed: await index.load(identity),
          mode: "full",
          reason:
            `${PARTIAL_INDEX_PREFIX}Embedding is unavailable, so search is `
            + `matching words rather than meaning: ${unavailable}`,
        };
      }
      await index.replaceFile(identity, file.path, embedded);
    }

    const stillMissing = totalEligible - batch.length;
    if (stillMissing > 0) {
      // Deliberately not recording the commit as built. The sha means "every
      // file at this commit is indexed", and claiming it early would make
      // every later search skip the rest — a permanently partial index
      // reporting itself as complete.
      return {
        indexed: await index.load(identity),
        mode: plan.mode,
        reason: withOversizedNote(
          `${PARTIAL_INDEX_PREFIX}Indexed ${alreadyIndexed.size + batch.length} `
            + `of ${alreadyIndexed.size + totalEligible} files so far. A `
            + `Worker can only make so many calls per request, so the index `
            + `is built across several searches — an alarm continues it `
            + `automatically, or search again to continue — `
            + `${stillMissing} file(s) to go.`,
          oversizedThisRound,
        ),
      };
    }

    // Written after every chunk has landed. A crash before this leaves the
    // previous sha and the next run redoes the work; the opposite order would
    // claim a build that never finished.
    await index.recordBuiltCommit(identity);
    await index.discardOtherCommits(identity);
    return {
      indexed: await index.load(identity),
      mode: plan.mode,
      reason: withOversizedNote(
        `Index complete: ${alreadyIndexed.size + batch.length} files.`,
        oversizedThisRound,
      ),
    };
  }

  // Incremental: carry forward what the previous commit had, then apply only
  // what changed. Rows are keyed by commit, so the previous commit's rows stay
  // readable for any session still using them.
  //
  // Carrying forward is one bulk copy rather than a write per file. Writing
  // each file separately would cost a subrequest per unchanged file, which for
  // a one-file edit means paying nearly the price of a full rebuild to avoid
  // one.
  if (builtSha) {
    const changedPaths = new Set(plan.changes.map((change) => change.path));
    await index.carryForward({
      from: {
        commitSha: builtSha,
        model: EMBEDDING_MODEL,
        pooling: EMBEDDING_POOLING,
      },
      to: identity,
      exceptPaths: [...changedPaths],
    });
  }

  // When more files changed than one round can process, this path runs again
  // on the next search with the same plan — `builtCommit` does not advance
  // until every change is in. Without skipping what earlier rounds already
  // did, it would reprocess the same first `FILES_INDEXED_PER_SEARCH` changes
  // forever and never reach the rest.
  //
  // A change is still outstanding when the target commit does not yet reflect
  // it. For an upsert that means its rows are not present; for a delete it
  // means its rows are still present (a delete removes them, and
  // `carryForward` never copied them because the path was excluded). So the
  // same "is this path in the current rows?" check settles both, in opposite
  // directions.
  const rowsAtTarget = new Set(
    (await index.load(identity)).map((entry) => entry.chunk.path),
  );
  const remainingChanges = plan.changes.filter((change) =>
    change.kind === "delete"
      ? rowsAtTarget.has(change.path)
      : !rowsAtTarget.has(change.path),
  );

  // Only the changed files scheduled this round need their text — an
  // unbounded fetch here would cost a subrequest per changed file regardless
  // of how many `FILES_INDEXED_PER_SEARCH` allows this call to use.
  const changesThisRound = remainingChanges.slice(0, FILES_INDEXED_PER_SEARCH);
  const upsertPaths = new Set(
    changesThisRound
      .filter((change) => change.kind === "upsert")
      .map((change) => change.path),
  );
  const refs = (await listStoreTree(config)).filter((ref) =>
    upsertPaths.has(ref.path),
  );
  const byPath = new Map(
    (await readStoreBlobs(config, refs)).map((file) => [file.path, file]),
  );
  const oversizedThisRound: string[] = [];
  for (const change of changesThisRound) {
    if (change.kind === "delete") {
      await index.removeFile(identity, change.path);
      continue;
    }
    const file = byPath.get(change.path);
    if (!file) {
      continue;
    }
    const chunks = chunkFile(file);
    const { embedded, unavailable, oversized } = await embedChunksOrExplain(
      chunks,
      embed,
    );
    recordOversized(oversized, oversizedThisRound);
    await index.replaceFile(identity, change.path, embedded);
    if (unavailable) {
      // Same reasoning as the full build: stop asking an embedder that is
      // refusing, and say why rather than failing the search.
      return {
        indexed: await index.load(identity),
        mode: plan.mode,
        reason:
          `${PARTIAL_INDEX_PREFIX}Embedding is unavailable, so search is `
          + `matching words rather than meaning: ${unavailable}`,
      };
    }
  }

  const unprocessed = remainingChanges.length - changesThisRound.length;
  if (unprocessed > 0) {
    return {
      indexed: await index.load(identity),
      mode: plan.mode,
      reason: withOversizedNote(
        `${PARTIAL_INDEX_PREFIX}${unprocessed} changed file(s) still to `
          + "index. An alarm continues it automatically, or search again to "
          + "continue.",
        oversizedThisRound,
      ),
    };
  }

  await index.recordBuiltCommit(identity);
  await index.discardOtherCommits(identity);
  return {
    indexed: await index.load(identity),
    mode: plan.mode,
    reason: withOversizedNote(null, oversizedThisRound),
  };
}

/**
 * Note oversized chunks, in the store's records and in this round's tally.
 *
 * A chunk that cannot be embedded stays lexically searchable — the search is
 * poorer for the missing vector but not broken. The failure is worth
 * surfacing, though: it means the chunker produced something over the model's
 * limit, which is a bug in the chunker, not in the store's content. Logged to
 * the console because Workers observability captures that, and folded into the
 * search's own `reason` so a caller sees it without going to the logs.
 *
 * @param oversized - What `embedChunks` could not embed this file.
 * @param tally - The round's running list of `path#ordinal` strings.
 * @returns Nothing.
 */
function recordOversized(
  oversized: { path: string; ordinal: number; estimatedTokens: number }[],
  tally: string[],
): void {
  for (const one of oversized) {
    console.warn(
      JSON.stringify({
        kind: "oversized_chunk",
        path: one.path,
        ordinal: one.ordinal,
        estimatedTokens: one.estimatedTokens,
        limit: EMBEDDING_MODEL_TOKEN_LIMIT,
      }),
    );
    tally.push(`${one.path}#${one.ordinal} (~${one.estimatedTokens} tokens)`);
  }
}

/**
 * Add a note about un-embeddable chunks to a build reason, if there were any.
 *
 * @param reason - The reason so far, or null for a clean build.
 * @param oversized - This round's `path#ordinal` strings.
 * @returns The reason with a trailing note, or the reason unchanged.
 */
function withOversizedNote(
  reason: string | null,
  oversized: string[],
): string | null {
  if (oversized.length === 0) {
    return reason;
  }
  const note =
    `${DEGRADED_INDEX_PREFIX}${oversized.length} chunk(s) were too long to `
    + `embed and are searchable by wording only: ${oversized.join("; ")}. `
    + "This is a chunker bug — the file needs splitting.";
  // Only ever appended to a non-partial reason. A partial build carries its
  // own PARTIAL prefix and will run again anyway; folding the degraded note
  // into that would be double-flagged and would not survive the next round.
  return reason && reason.startsWith(PARTIAL_INDEX_PREFIX)
    ? reason
    : reason
      ? `${reason} ${note}`
      : note;
}

/**
 * Decide whether one batch finished the build, from what it reported.
 *
 * Pure, and separated from `advanceIndexBuild` so this decision — the part
 * an alarm actually needs to know, "keep going or stop" — is testable
 * without a network call. `mode === "up_to_date"` is its own case rather
 * than folded into the prefix check because it carries no reason at all,
 * complete by having had nothing to do.
 *
 * @param outcome - What one batch call reported.
 * @returns Whether the index is now complete, and why not when it is not.
 */
export function buildProgress(
  outcome: { mode: RebuildMode; reason: string | null },
): { complete: boolean; reason: string | null } {
  if (outcome.mode === "up_to_date") {
    return { complete: true, reason: null };
  }
  const complete =
    outcome.reason === null || !outcome.reason.startsWith(PARTIAL_INDEX_PREFIX);
  return { complete, reason: outcome.reason };
}

/**
 * Advance the index by one batch, without running a search.
 *
 * The same batching `currentChunks` already does for a search call, exposed
 * on its own so something other than a search — a Durable Object alarm, in
 * particular — can drive an incomplete build forward. Reuses `currentChunks`
 * rather than duplicating its branches, so there is exactly one place that
 * decides what a batch does.
 *
 * @param config - Where the memory lives.
 * @param index - Where chunks and vectors are kept.
 * @param embed - How to embed, or null when unavailable.
 * @returns Whether the index is now complete, and why not when it is not.
 */
export async function advanceIndexBuild(
  config: MemoryRepoConfig,
  index: MemoryIndex,
  embed: Embedder | null,
): Promise<{ complete: boolean; reason: string | null }> {
  return buildProgress(await currentChunks(config, index, embed));
}

/**
 * Search the memory store.
 *
 * @param config - Where the memory lives.
 * @param index - Where chunks and vectors are kept.
 * @param embed - How to embed, or null when unavailable.
 * @param options - The query and what to return.
 * @param rawSearchSink - Where the full, pre-cascade candidate round is
 *   recorded. Defaults to discarding it.
 * @returns Results, and what the search could and could not see.
 */
export async function searchMemory(
  config: MemoryRepoConfig,
  index: MemoryIndex,
  embed: Embedder | null,
  options: SearchOptions,
  rawSearchSink: RawSearchSink = noOpRawSearchSink,
): Promise<SearchOutcome> {
  const { indexed, mode, reason } = await currentChunks(config, index, embed);

  const visiblePaths = new Set(
    applyDepth(
      indexed.map((entry) => entry.chunk.path),
      { includeDeep: options.includeDeep },
    ),
  );
  const visible = indexed.filter((entry) => visiblePaths.has(entry.chunk.path));
  const chunks = visible.map((entry) => entry.chunk);

  // Every lexical candidate with any score at all, best first. Cutting here
  // would discard candidates the cascade has not yet had the chance to
  // consider.
  const lexical = searchLexically(chunks, options.query);

  const exactCount = lexical.filter((hit) => hit.scores.exact > 0).length;

  let semantic: ReturnType<typeof searchSemantically> = [];
  let embedderUnavailable: string | null = null;
  const semanticAvailable = embed !== null && visible.some((one) => one.vector);
  if (embed && semanticAvailable) {
    let queryVector: Float32Array | undefined;
    try {
      [queryVector] = await embed([options.query]);
    } catch (error) {
      if (!isEmbedderUnavailable(error)) {
        throw error;
      }
      // The store may be fully indexed and only this one call refused. The
      // lexical half still answers, so the search returns rather than fails,
      // and the caller is told the semantic half is missing.
      embedderUnavailable =
        error instanceof Error ? error.message : String(error);
    }
    if (queryVector) {
      // Wide enough that the tiers above it can take their share without
      // starving the semantic quota — the pool is cut before the cascade
      // runs, so it must account for what earlier tiers will claim from it.
      semantic = searchSemantically(visible, queryVector, {
        limit: cosinePoolSize(options.quotas, exactCount),
      });
    }
  }

  // The full round, before the cascade cuts it down by quota — every
  // candidate either method found, not just what a caller ends up seeing.
  await rawSearchSink({
    query: options.query,
    chunksSearched: chunks.length,
    lexical,
    semantic,
  });

  const selected = cascadeResults(lexical, semantic, options.quotas);

  // After selection, never before: expanding first would let a neighbour's
  // text pull in a chunk that did not match on its own.
  const results = attachSiblings(selected, chunks, {
    maximum: MAXIMUM_SIBLINGS_PER_HIT,
  });

  return {
    results,
    searched: indexed.map((entry) => entry.chunk),
    // The store has vectors, but this query could not be embedded, so the
    // semantic half did not run. Reported as unavailable because that is
    // what it was for this search.
    semanticAvailable: semanticAvailable && !embedderUnavailable,
    indexMode: mode,
    indexReason: embedderUnavailable
      ? `${PARTIAL_INDEX_PREFIX}Embedding is unavailable, so this search `
        + `matched words rather than meaning: ${embedderUnavailable}`
      : reason,
  };
}

/** Re-exported so a caller can embed the same text the index did. */
export { chunkSearchText };
