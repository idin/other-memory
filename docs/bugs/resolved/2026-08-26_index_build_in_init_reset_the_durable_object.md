# Awaiting the index build in init() reset the Durable Object

## Expected

Connecting to the server registers its tools and answers. A search index that
needs rebuilding is rebuilt in the background, by the alarm that already
exists for exactly that purpose.

## What actually happened

ChatGPT reached the server, completed discovery, and got `ok` from `/mcp`
twice — then the connection died. `wrangler tail`:

```
--- .../.well-known/oauth-authorization-server | outcome: ok
--- .../.well-known/openid-configuration       | outcome: ok
--- .../.well-known/oauth-protected-resource/mcp | outcome: ok
--- .../mcp | outcome: ok
--- .../mcp | outcome: ok
--- | outcome: exceededWallTime
    EXCEPTION: A call to blockConcurrencyWhile() in a Durable Object waited
    for too long. The call was canceled and the Durable Object was reset.
```

## Root cause

`init()` ended with `await this.continueIndexBuild()`. `McpAgent` runs
`init()` inside `blockConcurrencyWhile()`, so every connection blocked on an
index batch before the server would answer anything.

The layout reorganisation earlier that day invalidated the index. With ~145
files to re-read from GitHub over the network, the batch exceeded the wall
clock, and Cloudflare cancelled the call and reset the object — so the
connection died before a single tool was served.

The comment above `continueIndexBuild` already said the alarm exists so a
build "keeps moving on its own", which makes awaiting it in `init()`
redundant as well as dangerous.

## The fix

`init()` now calls `await this.schedule(0, "continueIndexBuild")`. Scheduling
returns immediately; the alarm does the same work a moment later and
reschedules itself until the index is complete. A search arriving first
advances the build itself and reports the index as partial.

`continueIndexBuild` also catches its own failures now. It runs from an
alarm, where a throw means the alarm retries — a build failing for a durable
reason would have retried forever.

## Why a source-level test

The failure only appears against a real Durable Object under a real wall
clock, by which point it is live. `tests/init_does_not_block.source.test.ts`
asserts the shape of the source instead. The `.source.test.ts` suffix routes
it to the node project, since workerd has no filesystem.

## Verified

Fails against the pre-fix code:

```
 FAIL  tests/init_does_not_block.source.test.ts > continueIndexBuild is scheduled, never awaited in init
 FAIL  tests/init_does_not_block.source.test.ts > init schedules the build instead
      Tests  2 failed | 551 passed (553)
```

Passes with the fix:

```
      Tests  553 passed (553)
```

Resolved 2026-08-26 in 2.4.2.
