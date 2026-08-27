# Reading the mistake log exceeds the Worker subrequest limit

## What was expected

`gather_all_undigested_ai_mistakes` returns every undigested mistake entry so
a digest can be proposed.

## What actually happened

The tool failed outright:

```
The gather_all_undigested_ai_mistakes tool failed: Too many subrequests by
single Worker invocation. To configure this limit, refer to
https://developers.cloudflare.com/workers/wrangler/configuration/#limits
```

## The scenario that triggers it

`gatherDigestMaterial` in `src/digest.ts` fetches the branch and the tree in
two calls, then issues **one `repos.getContent` call per mistake file**:

```ts
for (const path of paths) {
  const file = await octokit.rest.repos.getContent({ ... });
}
```

`summariseMistakes` in `src/mistakes.ts` does the same thing through
`readEntry`, via `Promise.all`.

A Cloudflare Worker may make at most 50 subrequests per invocation. The log
held 45 entries when this failed, so the gather needed 47 and exceeded the
cap.

Two properties make this worse than a single broken tool:

1. **It fails precisely when it is needed.** The digest exists to compress a
   log that has grown large. The tool stops working *because* the log grew.
2. **`summariseMistakes` runs on every tool call**, attaching the undigested
   count to unrelated responses. Every tool on the server is now one call away
   from the same ceiling.

Measured against the live store:

```
mistake files in tree: 45
```

45 files + 1 tree call + 1 branch call = 47 subrequests, against a cap of 50.

## Why the obvious fix does not work

Fetching the directory rather than each file returns metadata only — GitHub
does not inline file contents in a directory listing. Verified against the
live API:

```
$ curl -s "https://api.github.com/repos/octocat/Hello-World/contents/"
README | type: file | has content field: False | content value: None
```

## Proposed fix

Read every entry through GitHub's GraphQL API in a single request, using
aliased `Blob` objects. Verified against the real store before being written:

```
mistake files in tree: 45
files returned in ONE request: 45
undigested: 45
total chars: 60,618
```

That is 2 subrequests total — one for the tree, one for all contents —
regardless of how many entries the log holds. It removes the ceiling rather
than raising it, which matters because any fixed batch size is exceeded by a
large enough log and reintroduces this same bug later.

Both `gatherDigestMaterial` and `summariseMistakes` must move to it. Fixing
only the digest leaves every other tool near the cap.

## Status

Open. Regression test written before the fix.

## Verification

`src/mistake_entries.ts` now reads every entry through two GraphQL requests,
and both `gatherDigestMaterial` and `summariseMistakes` delegate to it.

Measured against the live store, running the exact query shape the module
builds:

```
entries found:        45
entries returned:     45
undigested:           45
SUBREQUESTS USED:     2   (Worker cap is 50; old code needed 47)
```

Regression test `tests/reading_the_log_is_one_request.source.test.ts`, 5 tests.
Verified to fail before the fix:

```
Test Files  1 failed (1)
     Tests  4 failed (4)
```

and to pass after:

```
Test Files  1 passed (1)
     Tests  5 passed (5)
```

Tamper-tested by reintroducing a per-file `getContent` in the reader, which
fails the guard, then restoring:

```
with the fix broken:  Tests  1 failed | 4 passed (5)
restored:             Tests  5 passed (5)
```

## Status

Resolved 2026-08-27.

## Confirmed live

Published as `other-memory@2.4.6` and deployed
(version `9aad5b2f-c5f6-4bef-9ebe-b15c7d0b6146`).

The fix was verified present in the installed tree before deploying, not
assumed from the version number:

```
mistake_entries.ts               shipped (4445 bytes)
graphql / "on Blob" in it        2 / 1
readAllMistakeEntries in callers digest.ts 2, mistakes.ts 2
repos.getContent in callers      0, 0
```

That check mattered: the first `npm install other-memory@2.4.6` failed on
registry lag (`ETARGET`) and left the tree on 2.4.5. Deploying on the version
number alone would have shipped the old code, which is exactly how 2.4.1 was
deployed in place of 2.4.2 on 2026-08-26.

`gather_all_undigested_ai_mistakes` then ran against the live server and
returned all 47 entries, 71.9 KB — the same call that failed an hour earlier
with "Too many subrequests by single Worker invocation".

Live endpoint checks after deploy:

```
discovery      200
mcp endpoint   401 (unauthenticated, as expected)
github quota   2743/5000
```
