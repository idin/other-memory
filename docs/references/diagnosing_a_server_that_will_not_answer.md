# Diagnosing a server that will not answer

Written after 2026-08-26, when five distinct faults presented as the same
symptom — a client that would not connect, or a tool that never returned.
Each was found in a different place, and the order below is roughly cheapest
first.

## The symptom tells you less than it seems

| What the client says | What it usually means |
| --- | --- |
| Sends you to GitHub, then fails | `/authorize` is 500ing — a missing secret |
| "returned an error when connecting" | The MCP handshake threw; check `wrangler tail` |
| Spinner that never resolves, then 504 | The worker is waiting on something, not erroring |
| "not connected" but the plugin is listed | Client-side: enabled per chat, or per project |

The last one matters: **if no request reaches the worker, it is not a server
problem.** That single check separates half of these.

## The ladder

### 1. Is the worker healthy at all?

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://<worker>/.well-known/oauth-authorization-server
curl -s -o /dev/null -w "%{http_code}\n" https://<worker>/mcp
```

Discovery should be 200 and `/mcp` should be 401. **401 is correct** — it
means the endpoint is alive and demanding a token.

A 500 from `/authorize` on a real login almost always means a missing
secret. `npx wrangler secret list` should show all four;
`COOKIE_ENCRYPTION_KEY` is the one that goes unnoticed, because nothing
complains until someone tries to log in.

### 2. Does traffic arrive?

```sh
npx wrangler tail --format json
```

Then reproduce. If nothing appears, stop looking at the server — the client
never called it. If events appear but never complete, something is waiting.

`--format json` is worth the parsing: `outcome` distinguishes `ok` from
`exception` from `exceededWallTime`, and the last of those points straight
at the Durable Object rather than at your handler.

### 3. Is an external quota exhausted?

Two separate limits, and both present as hangs rather than errors.

```sh
# GitHub, using the same token the worker holds
curl -s -H "Authorization: token $TOKEN" https://api.github.com/rate_limit
```

Workers AI has no equivalent endpoint; its exhaustion appears in the logs as
`AiError: 4006`.

### 4. Has anything been recorded?

```sh
npx wrangler d1 execute <db> --remote --json \
  --command "SELECT tool, substr(message,1,90) msg, COUNT(*) n, MAX(timestamp) latest
             FROM tool_failures GROUP BY tool, msg ORDER BY latest DESC LIMIT 10"
```

An **empty** failure log during an active failure is itself a finding: it
means nothing is throwing, which means something is waiting.

## Absent evidence points downwards

The hardest fault of the day left no trace anywhere — no error, no log line,
no completed request — because the `octokit` package's bundled throttling
plugin *sleeps* on a rate limit rather than raising. The server's own backoff
never ran, since the error it keys on was swallowed a layer below.

When the evidence is missing rather than wrong, suspect a default in
something you did not write. Library defaults tuned for a script on a laptop
— wait and retry — are often exactly wrong inside a request with a caller on
the other end and a gateway timeout overhead.

## A fix that relocates work changes what runs how often

Three faults that day were caused by fixing the one before it:

1. A layout change invalidated the search index.
2. The rebuild was awaited in `init()`, which runs inside
   `blockConcurrencyWhile()` — the Durable Object was cancelled and reset.
3. Moving it to a schedule fixed that, but without `{ idempotent: true }`
   every restart added another build, so many ran at once.
4. The quota they drained was then silently waited out by the library.

Each fix was right. Each moved the failure somewhere less visible. Before
shipping one that moves work off a path, ask what now runs more often, and
what happens when many copies of it run together.

## Client-side, not server-side

Worth knowing before digging:

- **claude.ai / ChatGPT** cache the tool list at connect time. After changing
  tools, disconnect and reconnect.
- **Connectors are off per conversation by default**, and ChatGPT projects
  have their own connector settings separate from ordinary chats.
- **Claude Code** loads MCP tools at session start; a mid-session connection
  needs a restart. `--scope user` matters, or the server is invisible from
  any other directory.
- A deploy does **not** invalidate OAuth tokens. Changing
  `COOKIE_ENCRYPTION_KEY` does.

## Per-item work has a ceiling, and it arrives late

A Cloudflare Worker may make at most 50 subrequests per invocation. Anything
that reads one file per item is fine in testing and fails once the store grows
past the cap — long after the code was written, with nothing having changed.

On 2026-08-27 the digest read one file per mistake entry. At 45 entries it
needed 47 subrequests and failed outright:

```
Too many subrequests by single Worker invocation.
```

Two properties made it worse than a broken tool:

- **It failed exactly when it was needed.** The digest exists to compress a log
  that has grown, so it broke at the moment it became worth running.
- **The count that rides along with every tool response read the same way.**
  Every tool on the server was one entry from the same ceiling.

The fix was GraphQL with aliased `Blob` objects: every file's text in one
request, so the cost is constant. A batch size would only have moved the
ceiling — any fixed batch is exceeded by a large enough store.

The obvious cheaper fix does not work, and is worth ruling out early: a
GitHub directory listing returns metadata only, with no `content` field.

## A function nothing calls is not a feature

`digestedNote` was written, exported, and unit-tested. No tool ever called it.
The marker it produced was read by two filters and written by nothing, so the
digest loop ran one way only: entries could be gathered, never marked. The
store reached 47 mistakes with 0 digested.

Unit tests could not have caught it, because the function was correct. What
was missing was the wiring, which is only visible from outside the module.

When a capability exists but has never demonstrably run, check that something
reaches it before assuming it works.

## Two copies of a layout can agree with each other and both be wrong

After a layout reorg, the test fixture, the constant naming a path inside it,
and the sandbox reset script were all left on the old paths. Nothing failed,
because they agreed with each other.

Two integration tests assert the read-only guard refuses writes to the
instructions folder. With the fixture outside the guarded prefix, those writes
succeeded — the tests had stopped exercising the guard and begun exercising an
unprotected path. They failed loudly only because they asserted rejection.
Written the other way round, the suite would have stayed green while checking
nothing.

Fixtures, setup scripts and path constants are all copies of the layout. Check
them against the layout constants themselves, never against a second list.
