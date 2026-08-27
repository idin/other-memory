# No tool can mark a mistake as digested

## What was expected

After a digest, the entries it considered are marked so they do not resurface
at every future digest. `mistakes.ts` documents exactly this:

> A digest is what makes it a loop — patterns are drawn out of the entries and
> turned into something that prevents a recurrence, and the entries that
> contributed are marked as read.

`digest.ts` provides `digestedNote()` to build that marker, and documents why
even a fruitless entry must be marked:

> An entry that produced nothing still gets marked: otherwise the same entries
> resurface at every future digest, the count never falls, and a number that
> only ever grows is a number people stop reading.

## What actually happened

Nothing can write the marker. `digestedNote()` is exported, has a unit test in
`tests/digest.test.ts`, and is called from no tool and no other module:

```
$ grep -rn "digestedNote" src/*.ts
src/digest.ts:101:export function digestedNote(options: {
```

`DIGESTED_MARKER` appears only in reads — the filter in `summariseMistakes`
and the filter in `gatherDigestMaterial` — plus inside `digestedNote` itself,
which nothing invokes.

The log's own tools cannot append to an existing mistake entry either:
`append_memory` exists, but no digest-facing tool pairs it with
`digestedNote`, so closing the loop requires an agent to hand-construct the
marker text and the path — precisely what the layout design forbids everywhere
else.

## Consequence

The digest loop has never been closable. The store holds 47 mistakes and 0
digested, and the count has only ever risen. Every digest re-reads every entry
ever written, including ones already considered and deliberately answered with
nothing — which is the exact failure `digestedNote`'s doc comment predicts.

It also silently defeats the recurrence check, which is the digest's single
most valuable output: a pattern that reappears *after* a rule was written to
prevent it can only be spotted if the earlier entries are marked with what
they produced. Unmarked, every entry looks equally new.

## Proposed fix

A tool that takes a digest's outcome and marks the entries it covered:
entry paths, the date, and for each either the rules it contributed to or
nothing. It appends `digestedNote()` output to each entry via the existing
append path, so the marker text and placement are derived rather than
agent-authored.

It must accept entries that produced no rule. Marking only the productive ones
reproduces the same growing-count problem for everything else.

Idin still rules on what a digest adopts — this only records what was
considered, after he has ruled.

## Status

Open. Found on 2026-08-27 while trying to close out the first digest, after
Idin ruled that the entries with no mechanism should be marked digested with
no rule emitted.

## Fix applied

`src/digest_marking.ts` provides `markEntriesDigested`, registered as the
`record_digest_outcome` tool. It writes every entry in one commit through
`commitTreeChanges` — a per-file append would cost two subrequests each, which
at this log's size is the same ceiling that broke the gather it pairs with.

Entries that produced nothing are accepted and marked, which is the rule the
whole design rests on. Entries already carrying a marker are skipped rather
than marked twice, and unknown paths are reported rather than silently
ignored.

## The guard that prevents recurrence

Unit tests did not catch this bug, and could not have: `digestedNote` was
correct. What was missing was the wiring, which is only visible from outside
the module.

`tests/every_write_path_is_reachable.source.test.ts` asserts that every
capability the server means to expose is registered to a tool. Tamper-tested
by renaming the tool as it effectively was before:

```
× markEntriesDigested is reachable through record_digest_outcome
    Tests  1 failed | 4 passed (5)
```

and green once restored.

## Verification

Full suite:

```
Test Files  42 passed (42)
     Tests  627 passed (627)
```

Published as `other-memory@2.5.0` and deployed (version
`01310576-8120-4a50-aaae-4f526f914675`). Verified present in the installed
tree before deploying, using the `verify-before-deploy` skill written earlier
today:

```
version   ok  other-memory@2.5.0
present   ok  'markEntriesDigested' in 2 file(s)
present   ok  'record_digest_outcome' in 1 file(s)
present   ok  'commitTreeChanges' in 4 file(s)
Safe to deploy.
```

Live endpoints after deploy: discovery 200, mcp 401 unauthenticated.

## Status

Resolved 2026-08-27. The tool is live but not callable from the session that
built it — an MCP client's tool list is fixed at connection time, so reaching
a newly added tool needs a reconnect.
