# ensureTables ran on every index call and blew the subrequest budget

## Expected

`search_memory` and the `continueIndexBuild` alarm complete within a Worker's
per-invocation subrequest limit. The index build is deliberately batched
(`FILES_INDEXED_PER_SEARCH = 12`) so one round stays well under 50.

## Actual

After a `delete_memory_file` on 2026-09-10 added a commit, every
`search_memory` and every `continueIndexBuild` failed:

```
Too many subrequests by single Worker invocation.
```

From `list_tool_failures`:

```
19:25:02  search_memory        Too many subrequests by single Worker invocation
19:25:02  continueIndexBuild   Too many subrequests by single Worker invocation
19:24:53  continueIndexBuild   Too many subrequests by single Worker invocation
19:24:53  search_memory        Too many subrequests by single Worker invocation
```

A stuck loop: the alarm retried, failed the same way, rescheduled, repeated.
Search was completely unavailable.

## Root cause

`d1MemoryIndex`'s `ensureTables()` ran an unconditional
`database.batch([CREATE_CHUNK_TABLE, CREATE_STATE_TABLE])` — and every method
called it first: `load`, `replaceFile` (x12 in a full round), `removeFile`,
`carryForward`, `builtCommit`, `recordBuiltCommit`, `discardOtherCommits`.

A full-rebuild round:

- `load` -> ensureTables + SELECT = 2
- 12x `replaceFile` -> ensureTables + batch = 24
- `readBoundedBatch` -> tree + 12 blobs = 13
- 12 embed calls = 12
- `planRebuild` -> branch + compare = 2
- built-commit bookkeeping -> ~4

~57 subrequests. Roughly a dozen of them were `ensureTables` re-creating
tables that already existed — pure waste, and enough to push the round over
50. It had been latent; the delete's commit forced a reconcile that crossed
the line, and then the alarm kept it there.

This is a second instance of the pattern in
`2026-08-27_reading_the_mistake_log_exceeds_the_subrequest_limit.md`: an
operation whose subrequest cost scaled with something (there, log size; here,
number of index writes per round) without anyone counting it against the
ceiling.

## Trigger

Have a D1-backed deployment do a full or large incremental rebuild round
(12 files) in one `search_memory` call. The `ensureTables` overhead alone is
~12 extra subrequests.

## Fix (2026-09-10)

Memoize `ensureTables` per `d1MemoryIndex` instance: a `tablesReady` promise,
created on first call, reused after. A rejected create clears the memo so the
next call retries rather than reusing a failed promise. A Durable Object
reuses the instance across calls, so the DDL now runs once per object
lifetime instead of once per index method call.

## Verification

`tests/d1_memory_index.test.ts`:

- "many operations run the create batch exactly once" — load x2, builtCommit,
  replaceFile x2, removeFile, recordBuiltCommit -> create batch count is 1.
- "a failed create is retried, not cached as done" — first create throws,
  second call runs it again -> count is 2.

Full suite green: 593 worker + repository, 41 integration.

## Status

Fixed, tests green. Pending: publish + deploy.

## Follow-up (2026-09-10, same day): memoization alone was not enough

After deploying 2.5.2, `search_memory` and `continueIndexBuild` still failed
with the subrequest error. `ensureTables` was ~12 wasted subrequests, but the
round's real cost per file is three (blob read, embed call, D1 `replaceFile`),
not the "read and write" the `FILES_INDEXED_PER_SEARCH` doc assumed — and the
embed call had never been counted. At 12 files that is 36, plus ~13 fixed
overhead, still over 50.

`FILES_INDEXED_PER_SEARCH` lowered from 12 to 8 (`12 + 3*8 = 36`, real
headroom). The doc comment now derives the ceiling explicitly so the next
person can recompute it. Shipped in the same patch line.
