# A scheduling leak exhausted the GitHub rate limit

## Expected

The index build runs once at a time, paced by its alarm, and a GitHub API
that refuses is waited out rather than hammered.

## What actually happened

`list my memory files` hung in ChatGPT — "taking longer than expected to
return the file list, but the request is still running". `wrangler tail`
showed two things:

```
log: schedule("continueIndexBuild") called inside onStart() without
     { idempotent: true }. This creates a new row on every Durable Object
     restart, which can cause duplicate executions.

log: Request quota exhausted for request GET /repos/{owner}/{repo}/branches/{branch}
```

## Root cause

Two faults compounding, both introduced by the fix in 2.4.2.

`init()` scheduled `continueIndexBuild` without `{ idempotent: true }`, so
every Durable Object restart added another scheduled row. Several builds then
ran concurrently, each reading the whole store from GitHub.

`ALARM_RETRY_DELAY_SECONDS` is 5 — correct pacing for a build making
progress, and exactly wrong for one that is being refused. A rate-limited
build retried every five seconds, spending the quota it was waiting on.

Together they exhausted the hourly API allowance, and every tool that needed
GitHub hung.

## The fix

The scheduled build is now idempotent, so restarts reuse the existing row
rather than adding one.

`isRateLimited` distinguishes GitHub refusing for now from refusing
permanently — matched on message wording rather than the 403 alone, because
a 403 is also how GitHub answers a token lacking permission, which waiting
would never fix. A rate-limited build backs off to
`RATE_LIMITED_RETRY_DELAY_SECONDS` (60) instead of 5.

## Verified

Seven tests added. Confirmed they fail when both fixes are stubbed out:

```
 FAIL  tests/init_does_not_block.source.test.ts > the scheduled build is idempotent
 FAIL  tests/memory_repo.test.ts > the per-endpoint quota message is rate limiting
 FAIL  tests/memory_repo.test.ts > the primary hourly limit is rate limiting
 FAIL  tests/memory_repo.test.ts > a secondary limit is rate limiting
      Tests  4 failed | 556 passed (560)
```

and pass with them:

```
      Tests  560 passed (560)
```

## Note

This is the second bug caused by the 2.4.2 change. Fixing the wall-clock
crash moved the build off the request path but left it unbounded, which
turned one slow build into many. A fix that relocates work needs to ask what
now runs more often than before.

Resolved 2026-08-26 in 2.4.3.
