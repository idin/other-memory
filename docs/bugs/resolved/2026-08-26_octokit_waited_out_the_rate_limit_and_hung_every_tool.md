# Octokit waited out the rate limit, and every tool hung

## Expected

When GitHub refuses for rate reasons, the tool says so and the caller is
told to try again after the reset. The server's own backoff slows the index
build down until the quota recovers.

## What actually happened

`list_memory_files` never returned. ChatGPT reported:

```
The request reached Other Memory, but its server has not returned the file
list yet.
...
Other Memory is enabled, but list_memory_files timed out again with HTTP 504.
```

`wrangler tail` showed no completed events at all, and the GitHub quota went
from 5000 to 0 within minutes of resetting:

```
core: 0/5000 remaining
branches API: 403
```

The failure log in D1 held nothing recent — the most recent entry was ten
days old. Nothing was erroring, and nothing was finishing.

## Root cause

The `octokit` package bundles `@octokit/plugin-retry` and
`@octokit/plugin-throttling` and enables both by default. Their behaviour on
a rate limit is to **wait for the reset** rather than return an error — up
to an hour.

Inside a Worker that is indistinguishable from a hang. The request never
completes, the gateway answers 504, the client retries, and each retry
starts another request that will also sit and wait. Every waiting request
had already spent a call before being refused, which is how the quota
drained twice over.

It also explains the empty failure log and the silent backoff:
`isRateLimited` in `continueIndexBuild` keys on an error that never arrived,
because the plugin swallowed it a layer below and slept instead.

Waiting is a reasonable default for a script run from a laptop. It is the
wrong one for a request with a caller on the other end, who is better served
by "the rate limit is exhausted, try after 23:44" than by silence.

## The fix

`src/github_client.ts` is now the only place an Octokit is constructed, and
it disables both behaviours:

```ts
retry: { enabled: false },
throttle: {
  onRateLimit: () => false,
  onSecondaryRateLimit: () => false,
},
```

Ten call sites were each doing `new Octokit({ auth })` independently and
were free to drift. They all go through the factory now, and a source-level
test fails if a new one appears.

With the error surfacing again, the two fixes that were already in place
start working: the build backs off to 60 seconds, and the tool reports the
rate limit and its reset time instead of hanging.

## Verified

Fails when retry is re-enabled:

```
 FAIL  tests/github_client.source.test.ts > the shared client disables retry and throttling waits
      Tests  1 failed | 564 passed (565)
```

Passes with the fix:

```
      Tests  565 passed (565)
```

## Note

This is the fourth bug in one chain, and the third caused by fixing the one
before it. The order was: index invalidated by a layout change → rebuild
awaited in `init()` reset the Durable Object → scheduling the rebuild
without `idempotent` ran many at once → the quota they drained was then
waited out silently by a library default nobody had looked at.

Each fix was correct and each moved the failure somewhere less visible. The
lesson worth keeping is the one about layers: three of these were only
findable in `wrangler tail`, and the last one was invisible even there,
because the symptom of a library sleeping is *nothing at all* — no error, no
log line, no completed request. When the evidence is absent rather than
wrong, suspect something below the code being read.

Resolved 2026-08-26 in 2.4.5.
