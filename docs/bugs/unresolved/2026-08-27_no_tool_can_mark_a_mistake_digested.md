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
