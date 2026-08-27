# The test fixture was left on the old layout

## What was expected

The integration suite asserts that the read-only guard refuses writes to the
instructions folder — both an append and a delete must be rejected.

## What actually happened

Both tests failed, because the writes **succeeded**:

```
FAIL |integration| tests/integration/memory_repo.integration.test.ts
  > appending > refuses to write to the read-only instructions
AssertionError: promise resolved "{ …(3) }" instead of rejecting

FAIL |integration| tests/integration/memory_repo.integration.test.ts
  > creating, moving and deleting > refuses to delete the read-only instructions
```

The delete returned a commit rather than throwing:

```
+   "commitSha": "0686035c292e77202d186282f18b4df5b2039f6f",
+   "path": "other-memory/instructions/standing_instructions.md",
```

## Root cause

The layout reorg moved instructions, decisions, capture rules and mistakes
under `guidance/`. `INSTRUCTIONS_PREFIX` became
`other-memory/guidance/instructions/`. The test fixture was never migrated and
is still on the pre-reorg layout:

```
tests/fixture/other-memory/capture_rules/what_to_capture.md
tests/fixture/other-memory/decisions/2026.md
tests/fixture/other-memory/instructions/standing_instructions.md
tests/fixture/other-memory/future/todos/2026-01-15_replace_extractor_fan.md
```

`future/` no longer exists in the layout at all. `FIXTURE_INSTRUCTIONS` in
`tests/integration/sandbox.ts` still points at the old path.

So the guard is correct and the fixture is wrong. The seeded file sits outside
the namespace the guard protects, and writing to it is genuinely permitted —
the tests were asserting against a path the rule was never going to cover.

## Why this is worse than a failing test

These two tests exist to prove the read-only guard holds. Once the fixture
drifted, they stopped exercising the guard and started exercising an unguarded
path. Had the assertions been written the other way round — expecting success
— the suite would have gone green while testing nothing.

A fixture that drifts from the layout it is meant to represent turns a
security assertion into a no-op silently. Nothing in the suite notices, because
every individual test still runs.

## Proposed fix

1. Migrate the fixture tree to the current layout: `capture_rules/`,
   `decisions/`, `instructions/` and `mistakes/` move under `guidance/`, and
   `future/todos/` becomes `work/todos/open/`.
2. Update `FIXTURE_INSTRUCTIONS` and any sibling constants to the new paths.
3. Add a test that asserts every fixture path sits within a prefix the layout
   actually declares — so the next reorg fails loudly here instead of quietly
   disarming a guard.

Step 3 is the part that prevents recurrence. Steps 1 and 2 fix today's
instance; only step 3 stops the fixture drifting again.

## Status

Open. Found while running the full suite after an unrelated fix.

## A second instance of the same drift, found while fixing the first

Moving the fixture folders broke every integration test at setup:

```
Test Files  4 failed | 36 passed (40)
     Tests  41 failed | 576 passed (617)

Error: Command failed: ./scripts/sandbox/reset.sh
cp: .../tests/fixture/other-memory/instructions: No such file or directory
```

`scripts/sandbox/reset.sh` rebuilds the sandbox repository by copying fixture
folders **by literal name**, four of them. Three had moved:

- `other-memory/instructions` → `other-memory/guidance/instructions`
- `other-memory/capture_rules` → `other-memory/guidance/capture_rules`
- `other-memory/decisions` → `other-memory/guidance/decisions`
- `other-memory/future` → `other-memory/work`

This is the same fault as the fixture itself — a hardcoded copy of the layout,
one file further out — and it had been stale since the reorg. It went unnoticed
because the fixture was stale in a matching way, so the two wrong things
agreed with each other.

## Fix applied

1. Fixture tree migrated with `git mv` to the current layout.
2. `tests/fixture/other-memory/guidance/decisions/2026.md` split into two dated
   files, so the fixture satisfies `DECISION_LOG_PATTERN` rather than the
   pre-reorg yearly-log shape.
3. `FIXTURE_INSTRUCTIONS` in `tests/integration/sandbox.ts` repointed.
4. `scripts/sandbox/reset.sh` updated for all four folders.
5. `tests/fixture_matches_the_layout.source.test.ts` added, 7 tests, checking
   the fixture against the **layout constants themselves** rather than against
   a second copy of the expected paths — a second list would drift the same way
   the first one did. It also checks every folder the reset script copies
   exists in the fixture.

## Verification

The new guard passes:

```
Test Files  1 passed (1)
     Tests  7 passed (7)
```

Tamper-tested against the exact drift that caused the outage — moving the
fixture back to the old layout:

```
× the read-only fixture file is inside the guarded prefix
× the constant the integration tests use points inside the fixture
AssertionError: expected 0 to be greater than 0
     Tests  2 failed | 4 passed (6)
```

And against the reset script drifting:

```
× every path the sandbox reset script copies exists in the fixture
AssertionError: reset.sh copies instructions, absent from fixture
     Tests  1 failed | 6 passed (7)
```

Both restored to green afterwards.
