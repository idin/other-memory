# An exhausted AI quota killed the whole MCP connection

## Expected

Embedding is optional. Without it, search matches words rather than meaning
and says so — that is stated in `embeddings.ts`, in the README, and in the
`wrangler.d1.example.jsonc` comments. A deployment whose Workers AI binding
stops answering should keep serving lexical search.

## What actually happened

Every client — claude.ai, the mobile app, Claude Code — failed to connect to
`other-memory-mcp` with only "the MCP server returned an error when
connecting". OAuth was fine: `/callback` and `/token` both returned ok.

`wrangler tail` showed the real cause on `/mcp`:

```
--- https://other-memory-mcp.idin-cf5.workers.dev/callback?code=... | outcome: ok
--- https://other-memory-mcp.idin-cf5.workers.dev/token | outcome: ok
--- https://other-memory-mcp.idin-cf5.workers.dev/mcp | outcome: exception
    EXCEPTION: Error | AiError: 4006: you have used up your daily free
    allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid
    plan if you would like to continue usage.
    error : Error on server: AiError: 4006: ...
    error : Override onError(error) to handle server errors
```

## The trigger

The layout reorganisation earlier that day moved ~145 files, which
invalidated the search index. On connect the server began rebuilding it,
embedding every chunk, and exhausted the 10,000-neuron daily free allowance.
`embedChunks` then threw, and nothing caught it: the exception escaped
`searchMemory`, reached the agent, and took the connection down with it.

An optional feature was able to break a deployment that never asked for it.

## Root cause

Three unguarded `await` calls on the embedder in `search_memory.ts` — two in
the index build, one embedding the query. Any throw from the embedding
service propagated out of the request.

## The fix

`isEmbedderUnavailable` distinguishes a service refusing work (quota, rate
limit, capacity) from a text that cannot be embedded. The first is temporary
and says nothing about the input, so it becomes the documented fallback:
chunks are stored without vectors and the caller is told why. The second is a
bug and still throws.

`embedChunksOrExplain` wraps the two build sites; the query site catches
directly, since a store can be fully indexed and only that one call refused.
In every case `indexReason` carries the explanation, so an empty result reads
as "could not search properly" rather than "not recorded".

## Verified

Six regression tests added in `tests/embeddings.test.ts`. Confirmed they fail
when the guard is stubbed out:

```
 FAIL  tests/embeddings.test.ts > the daily allowance running out is recognised as unavailable
 FAIL  tests/embeddings.test.ts > a rate limit is recognised as unavailable
 FAIL  tests/embeddings.test.ts > chunks come back without vectors, and with the reason
      Tests  3 failed | 547 passed (550)
```

and pass with it in place:

```
 Test Files  32 passed (32)
      Tests  550 passed (550)
```

Resolved 2026-08-26 in 2.4.1.
