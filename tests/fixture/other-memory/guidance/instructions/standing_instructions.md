# Standing instructions

Everything in this repository is invented. It exists so the integration tests
have a memory repository to act on that resembles a real one in shape and in
nothing else. No person, pet, address or decision described here corresponds to
anybody.

## Layout

- `facts/` — what is true about the person, one file per subject.
- `decisions/` — one file per year, appended to, never rewritten.
- `future/todos/` — one file per task, dated. Sitting in the folder is
  what open means.
- `past/` — what resolved: finished todos, decided proposals.
- `messages/inbox/<agent>/` — notes between agents.

## Rules

- Append; never overwrite. A correction is a new entry that supersedes the old
  one, with the old text struck through and dated, so the change stays visible.
- Never write down anything that can be derived. An age goes stale within a
  year; a birth date does not.
- This file is read-only. The server can read it and must refuse to write to
  it — which is one of the things the integration tests check.
