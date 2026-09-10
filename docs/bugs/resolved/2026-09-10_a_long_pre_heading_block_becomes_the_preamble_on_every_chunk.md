# A long pre-heading block becomes the file preamble on every chunk

## Expected

`chunkFile` splits a store file into chunks that each fit the embedding
model's 512-token limit. `enforceTokenTarget` exists to guarantee this: it
splits any oversized unit by paragraph, then sentence, then hard character
cut.

## Actual

`other-memory/infrastructure/email/gmail_filters.md` (114 lines, ~2578
tokens) produced three chunks, and **every one exceeded the limit** at
~2509-2531 tokens. `search_memory` then failed completely — for every
query, on every topic — because one un-embeddable chunk throws
`TextTooLongToEmbedError` at the embedding call site and aborts the whole
index build.

Incidents: 2026-09-08 (search for "favourite bands albums songs music
taste"), 2026-09-09 (second occurrence). Both logged automatically and
visible via `list_tool_failures`.

## Root cause

The file's shape: one `#` H1, then ~104 lines of numbered filter list with
**no blank lines and no `##` sub-heading**, then a single `## Notable issues
observed` section at line 110.

In `splitMarkdown`, `flush()` classifies everything before the first H2 as
the file preamble:

```js
if (bufferHeadings.length <= 1 && !seenHeading) {
  preamble = body;
  return;
}
```

So the entire 104-line list (~2446 tokens) becomes `filePreamble`. The three
real body chunks, correctly split from the "Notable issues" section, are
tiny (43-64 tokens). But `chunkSearchText` prepends the full preamble to
every chunk, pushing each to ~2500 tokens.

`enforceTokenTarget` never fixes this because it only ever measures and
splits the **body**. It receives `prefixTokens` but uses it only to shrink
the body's budget, flooring at `MINIMUM_BODY_TOKENS = 64`. The preamble
itself is never split.

This is a known gap, not a surprise. The `MINIMUM_BODY_TOKENS` doc comment
says: "A file with a preamble longer than the whole budget would otherwise
drive the available body size to zero... such a chunk exceeds the target and
is reported by the assertion at the embedding call site." The author chose
to let the embedder throw rather than handle it — and that throw is
fatal to the entire search.

## Trigger

```
Store file: other-memory/infrastructure/email/gmail_filters.md
  # Gmail filters (idin@idin.ca) — as of September 3, 2026

  <intro paragraph>

  1. `filter` → action
  2. `filter` → action
  ... 104 lines, no blank lines ...

  ## Notable issues observed
  - point
```

Run `chunkFile` on it; every returned chunk's `chunkSearchText` exceeds
512 tokens.

Reproduced 2026-09-10 with a source test against the pre-split file
(`git show 92f0b4b~1:.../gmail_filters.md`):

```
file: 10310 chars, 114 lines, ~2578 tokens
3 chunks
  #0: ~2531tk OVER
  #1: ~2531tk OVER
  #2: ~2509tk OVER
```

## Two fixes, both wanted (matches the two open proposals)

**1. Cap the preamble.** Content before the first `##` should only become
the preamble up to a sane size (a scope note is a sentence or two). Beyond
that it is body content and must be chunked like any other section, not
welded onto every chunk. This is the
`2026-09-09_chunking_guard_and_non_fatal_search_failures.md` proposal's
write-time-guard half, applied at chunk time.

**2. Non-fatal embedding failure.** Even with #1, a chunk that cannot embed
for any reason must be skipped and reported, and the search must return
partial results with a note — never abort. Independently wanted per Idin.

## Status

Open. Reproduced. Neither fix built.

## Fix (2026-09-10)

Three changes, `other-memory` package:

**1. `chunking.ts` — cap the preamble.** New `MAXIMUM_PREAMBLE_TOKENS`
(`CHUNK_TARGET_TOKENS / 2` = 160). In `splitMarkdown`'s `flush()`, a
pre-`##` block over that size keeps only its leading paragraphs as the
preamble and emits the rest as an ordinary chunk under the H1, which then
goes through `enforceTokenTarget` like any section. `gmail_filters.md`
(pre-split) now yields 12 chunks of 173-317 tokens each, all under 512.

**2. `embeddings.ts` — non-fatal oversized chunks.** `embedChunks` now
partitions before embedding: a chunk whose `chunkSearchText` exceeds the
limit is skipped (kept with `vector: null`, still lexically searchable) and
returned in an `oversized` list rather than throwing for the whole batch.
`embedChunksOrExplain` passes the list through.

**3. `search_memory.ts` — surface it without looping.** Both build paths
collect the round's oversized chunks. `recordOversized` logs each as a
structured `console.warn` (captured by Workers observability, visible with
the failure log) and tallies it. `withOversizedNote` folds a caveat into the
build `reason` using a new `DEGRADED_INDEX_PREFIX` — deliberately *not*
`PARTIAL_INDEX_PREFIX`, because an oversized chunk is not unfinished work and
`buildProgress` must treat the build as complete or the alarm reschedules
forever re-embedding the same doomed chunk. `index.ts` flags a response
partial on either prefix.

Tests: `chunking.test.ts` "a long block before the first H2 is chunked";
`embeddings.test.ts` "an oversized chunk is skipped, not fatal, and
reported" + "a batch of only oversized chunks makes no embedding call".

## Status

Fixed, tests green. Pending: publish + deploy.
