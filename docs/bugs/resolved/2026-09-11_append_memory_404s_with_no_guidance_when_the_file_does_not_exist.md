# append_memory 404s with no guidance when the file does not exist

## Expected

`append_memory` is documented as working on "an existing memory file." When
called on a path that does not exist yet, the caller should get a clear
error telling them to use `create_memory_file` instead.

## Actual

A raw GitHub API 404 escapes from `readMemory`'s `getContent` call, with no
indication of what went wrong or what to do about it:

```
Error: Not Found - https://docs.github.com/rest/repos/contents#get-repository-content
Location: fetchWrapper (worker.js:26996:11)
```

Reported via `list_tool_failures`, two attempts, both failed:

```
2026-09-11T19:03:11.948Z
  path: other-memory/guidance/mistakes/gmail-reply-sends-not-drafts.md
  commit_message: docs: record mistake - Gmail:reply sends immediately, not a draft
  text: 1217 chars

2026-09-11T19:03:19.625Z
  path: other-memory/guidance/mistakes/gmail-reply-sends-not-drafts.md
  commit_message: docs: record mistake - Gmail reply sends immediately not draft
  text: 744 chars (shorter retry)
```

## Root cause

`appendMemory` in `src/memory_repo.ts` calls `readMemory` unconditionally
before appending, to get the existing content and blob sha. `readMemory`
calls `octokit.rest.repos.getContent`, which throws its own 404 when the
path does not exist — `appendMemory` has no try/catch around that call, so
the raw Octokit error propagates untouched.

The design itself is correct: `append_memory`'s tool description already
says "an existing memory file," and `create_memory_file` is the tool for a
new one. The bug is that the failure mode for calling it on the wrong path
is an opaque GitHub error rather than a message pointing at the fix — and
in this case, the mistake was never recorded at all, on either attempt.

## Trigger

```ts
await appendMemory(config, "other-memory/guidance/mistakes/does_not_exist_yet.md", "text", "msg");
```
throws a bare GitHub 404 rather than a clear, actionable error.

## Proposed fix

Catch the 404 in `appendMemory` (or in `readMemory`, scoped to this call
site) and re-throw a clear error: something like "`<path>` does not exist.
Use `create_memory_file` to create it first." This is a caller-facing UX
fix, not a change to what the tool is allowed to do.

## Status

Open. Fix proposed, not yet built.

## Fix built (2026-09-11)

Went further than the proposed fix above. Rather than catching the 404 and
pointing the caller at `create_memory_file`, `appendMemory` now creates the
file itself when it does not exist — "append this fact" has one correct
behaviour whether or not the target already exists, so the caller should
never need to know in advance which tool to call.

`readMemory`'s 404 is caught (`isMissingFile`, matching `error.status === 404`
— the same shape `isRateLimited` already checks elsewhere in this file) and
treated as "starts empty" rather than re-thrown. The GitHub write then omits
`sha` when creating (required by the contents API to distinguish create from
update) and includes it when appending, so a genuine concurrent-edit race is
still caught.

Also added the two structural checks `createMemoryFile` already had that
`appendMemory` lacked — no trailing slash, extension must be `.md`/`.yaml` —
since a caller can now reach either code path from one tool call.

Tool description updated: no longer says "an existing memory file," now
states plainly that the file is created if missing.

## Verification

Regression test `tests/integration/memory_repo.integration.test.ts` —
"appending to a path that does not exist yet creates it instead of failing":

```
Test Files  1 passed | 3 skipped (4)
     Tests  1 passed | 42 skipped (43)
```

Verified to fail with the exact reported error when the fix is reverted:

```
FAIL ... appending to a path that does not exist yet creates it instead of failing
HttpError: Not Found - https://docs.github.com/rest/repos/contents#get-repository-content
```

Full worker + repository suite: 593 passed, 40 files.

Full integration suite (real GitHub): 43 passed, 4 files. 636 tests total
across worker + repository + integration.

## Status

Resolved 2026-09-11. Pending: publish + deploy.
