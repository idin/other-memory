# Publishing to npm: the complete procedure

Everything needed to publish a package to npm from this machine, for the
`ixmachina` account — the first publish of a brand-new name, and every
publish after it.

**This document exists because a previous version of the npm notes in this
folder contained an unverified claim that sent an agent down a wrong path
for an hour.** Every factual claim here carries its verification method and
date. A claim without one is a claim to re-verify, not to act on.

## Start here: the decision procedure

Follow this in order. Every branch ends in either a completed publish or a
single named action for a named actor. **There is no branch that ends in
"blocked" or "cannot proceed"** — if you reach one, you have left the
procedure.

```
1. Does the package already exist on npm?
   Run: ~/.claude/skills/check-package-registry/check_package.sh npm <package>

   EXISTS  -> go to 2 (Procedure B, ordinary publish)
   NOT     -> go to 3 (first publish)

2. Is there a token scoped to it in ~/code/.env?
   Run: ~/.claude/skills/find-credential/find_credential.sh npm
   Confirm its scope: curl the registry token endpoint (see below)

   YES, and not expired -> publish with it. Procedure B. DONE.
   YES, but expired     -> ASK IDIN: "create a replacement granular token
                           scoped to <package>, read+write, bypass_2fa on,
                           and save it to ~/code/.env as NPM_TOKEN_<PKG>"
   NO                   -> ASK IDIN: same as above.

3. First publish. Is NPM_TOKEN_BOOTSTRAP in ~/code/.env already?
   Run: ~/.claude/skills/find-credential/find_credential.sh bootstrap

   YES -> publish with it (Procedure A2 step 5), then go to 4.
   NO  -> ASK IDIN: "run `npm login` then
          `npm publish --access public` in your own terminal, in
          /path/to/package, and tell me the output."

          Succeeds        -> go to 4.
          Fails with EOTP -> record the verbatim error in this file's
                             status table, then ASK IDIN for a bootstrap
                             token per Procedure A2 step 2-4.
          Fails otherwise -> paste the error, diagnose from it. Do not
                             guess at a cause.

4. Package now exists. ASK IDIN: "create a granular token scoped only to
   <package>, read+write, bypass_2fa on, save as NPM_TOKEN_<PKG>, and
   revoke the bootstrap token if one was used."
   Then record the new token in the inventory table below. DONE.
```

### The three things — and only these three — to ask Idin for

1. Run an exact command in a real terminal and report the output.
2. Create a token with exact named settings and write it into `~/code/.env`
   himself under a given variable name.
3. An approval: a version bump, a new repo, a name.

Anything else you were about to ask for, find yourself. Anything you were
about to declare impossible, check against the actor table first.

## Status of each claim

| Claim | Verified how | Date | Confidence |
| --- | --- | --- | --- |
| Granular tokens are web-UI-only, not CLI/API | GitHub changelog, 2025-11-05 | 2026-09-12 | Confirmed |
| Classic tokens can no longer be created | GitHub changelog, 2025-11-05 | 2026-09-12 | Confirmed |
| Write tokens capped at 90-day lifetime | GitHub changelog, 2025-11-05 | 2026-09-12 | Confirmed |
| `bypass_2fa` still exists, off by default | GitHub changelog, 2025-11-05 | 2026-09-12 | Confirmed |
| Token creation endpoint rejects `bypass_2fa` tokens (403) | npm registry API docs | 2026-09-12 | Confirmed |
| A token scoped to package A gets 403 publishing package B | Observed directly | 2026-09-12 | Confirmed |
| The granular-token picker cannot scope to a nonexistent package | Observed on npmjs.com | 2026-08-16 | Confirmed |
| There is no browser publish flow on npmjs.com | npm CLI docs | 2026-08-16 | Confirmed |
| WebAuthn/passkey works for CLI auth, not just web | npm 2FA docs, quoted below | 2026-09-12 | Confirmed |
| **`npm login` + `npm publish` fails `EOTP` on a passkey-only account** | **Never actually observed** | — | **UNVERIFIED — see below** |

## The unverified claim that caused the problem

The earlier `granular_access_tokens.md` in this folder asserted:

> 2FA-via-passkey-only accounts (no TOTP) cannot supply `--otp=<code>` to
> `npm publish` — `npm login` succeeds via passkey, but `npm publish` still
> demands a TOTP code the account cannot produce, and fails with `EOTP` even
> after a successful login.

**This has never been observed.** It contradicts two things:

1. `keep`'s own mistake log,
   `guidance/mistakes/2026-08-16_told_idin_to_publish_via_a_web_ui_that_does_not_exist.md`,
   written the *same day*, which states the correct path is "`npm login`
   (passkey works interactively) followed by `npm publish`".
2. npm's own 2FA documentation, which says plainly:
   > "security-key with WebAuthn can be used for authentication from both
   > the web and the command line, but it can only be configured from the
   > web."

The one real failure observed on 2026-09-12 was **403 Forbidden — "You may
not perform that action with these credentials"** when publishing
`musix-box` with a token scoped to `other-memory`. That is a *scope*
failure. It is not `EOTP`, and it says nothing about whether `EOTP` would
occur under an interactive login.

**Do not build a plan on the EOTP claim until someone runs the test in
"Open question" below and records the result here.**

## Who does what — the three agents and the human

Idin works with more than one agent, each with different access. Most of the
wasted hour on 2026-09-12 came from one agent attempting steps that were
structurally impossible for it, instead of handing them to the one that
could. Read this table before assigning any step.

| Actor | Has | Cannot |
| --- | --- | --- |
| **VS Code / Claude Code agent** (the CLI agent, e.g. this one) | Filesystem read/write, shell, git, `npm publish`, `wrangler`, can read `~/code/.env` | No browser. No interactive stdin — the harness pipes `/dev/null` into every command, so `npm login`, `wrangler login`, and any passkey prompt are impossible. One-time login URLs reach it pre-redacted to `***`. |
| **Chrome Claude extension** (the browser agent) | A logged-in browser session, can read and click pages | No filesystem. Cannot write `~/code/.env`. The auto-mode classifier denies npm's token pages entirely — `Reason: [Secret-Store Writes]` — including the read-only token list. Correctly refuses to carry live credentials through a transcript. |
| **Idin** | A real terminal, a real browser, and the passkey/WebAuthn hardware | — |

### Step assignment for a first publish

1. **CLI agent** — everything up to the publish: write the code, tests
   green, typecheck clean, `package.json` correct, git repo created and
   pushed, `wrangler` resources and secrets set, version bump proposed for
   approval.
2. **CLI agent** — verify the account and the package name:
   `check_package.sh npm <package>` and
   `find_credential.sh npm`. Never guess either.
3. **Idin** — run Procedure A1 in a real terminal: `npm login`, complete
   the passkey, then `npm publish --access public`. This is a human step
   only because of the passkey and the interactive stdin, not because the
   agent lacks the knowledge. **Do not ask the browser agent to do this** —
   it has no terminal, and the login URL is unreadable to the CLI agent.
4. **CLI agent** — if A1 succeeds, record the result in this file's status
   table and stop. Nothing else is needed.
5. **Idin** — only if A1 fails: create the bootstrap token on npmjs.com
   (passkey gesture), and paste it into `~/code/.env` yourself as
   `NPM_TOKEN_BOOTSTRAP`. **Do not route it through either agent's
   transcript.** The browser agent cannot write the file, and a live
   all-packages credential should not appear in chat.
6. **CLI agent** — publish using that variable read from the file, then
   tell Idin which narrow token to create and which broad one to revoke.
7. **Idin** — create the narrow token, save it as
   `NPM_TOKEN_<PACKAGE>`, revoke the bootstrap.

### What to ask the human for, and what not to

The only things that should ever be asked of Idin:

- "Run this exact command in your terminal and tell me the output" — for
  anything needing interactive stdin or a passkey.
- "Create this token with these exact settings and put it in `~/code/.env`
  as `<NAME>`" — for a credential that cannot be minted programmatically.
- An approval decision: a version bump, a new repo, a name.

Never ask Idin to:

- Paste a live credential into chat. Have him write it to `~/code/.env`; an
  agent reads it from there.
- Repeat something already recorded. Check `~/code/.env`, the registry API,
  and this folder first. "There is no `idin` npm account" has been
  rediscovered more than once.
- Relay a message to another agent that the sending agent has not verified
  is possible for the receiving agent. Check the table above first.

## Accounts and credentials

There is exactly one npm account: **`ixmachina`** (`idin@ixmachina.ai`).
There is no `idin` npm account — this has been asserted wrongly more than
once. Confirm with
`~/.claude/skills/check-package-registry/check_package.sh npm <package>`,
which reports the real owner, rather than inferring from `package.json`'s
`author` field or the GitHub owner.

Credentials live in `~/code/.env` only. Find them with
`~/.claude/skills/find-credential/find_credential.sh npm` — never guess a
variable name and conclude a token is absent.

### Reading token metadata

The registry exposes every token's own scope, permissions, expiry and
`bypass_2fa` flag. This is the authoritative check, not the web UI:

```sh
set -a && source ~/code/.env && set +a
curl -s -H "Authorization: Bearer ${NPM_TOKEN_IXMACHINA_OTHER_MEMORY_AGENT_WRITE_BYPASS_2FA}" \
  https://registry.npmjs.org/-/npm/v1/tokens | python3 -m json.tool
```

Returns, per token: `name`, `description`, `key`, masked `token`, `expiry`,
`cidr`, `bypass_2fa`, `revoked`, `created`, `accessed`, `permissions`, and
`scopes`. Use it to confirm a token's scope before blaming a publish
failure on anything else.

**A `bypass_2fa: true` token cannot create other tokens** — npm returns 403
from the create endpoint by design, so an agent holding a publish token
cannot mint more credentials. That gate is deliberate and not worth
attempting to route around.

## Why the first publish of a new name is different

A granular token's scope is fixed at creation to an explicit list of package
names. There is no CLI or API call that edits an existing token's scope.

npmjs.com's granular-token form can only scope to packages that **already
exist on the registry** — a package never published cannot appear in its
picker. So the first publish of a brand-new name cannot use a token scoped
to that name: there is nothing yet to scope to.

This is structural, the same shape as fine-grained GitHub PATs, and not a
symptom of doing something wrong.

## Procedure A — first publish of a brand-new package name

Try these in order. **A is strongly preferred** because it mints no
broad credential at all.

### A1. Interactive login (try this first)

Requires a real terminal — `npm login` needs interactive stdin, and the
Claude Code harness pipes `/dev/null` into every command, so an agent
cannot drive it. This is a human step.

```sh
cd /path/to/package
npm login          # complete the passkey/WebAuthn prompt
npm whoami         # must print: ixmachina
npm publish --access public
```

`--access public` matters for a first publish: without it a scoped package
defaults to restricted and fails on a free account.

If this succeeds, **stop** — no bootstrap token was needed. Record the
result in this file's status table.

### A2. One-time bootstrap token (only if A1 fails)

Only if A1 produces a real, recorded failure. This mints an all-packages
write credential, so it is the fallback, not the default.

1. npmjs.com → profile icon → **Access Tokens** → **Generate New Token** →
   **Granular Access Token**
2. **Name:** `<package>-bootstrap`
   **Description:** say what it is for and that it must be revoked — per
   the documentation rule, "optional" describes the form, not the reader's
   needs
   **Expiration:** shortest available (7 days)
   **Packages and scopes:** **All packages** — the new name cannot be
   picked individually
   **Permissions:** **Read and write**
   **Bypass two-factor authentication:** **enabled**
3. Complete the passkey gesture. Copy the token — shown once only.
4. Save it to `~/code/.env` as `NPM_TOKEN_BOOTSTRAP`. **Do not paste a live
   all-packages credential into any chat transcript** — not to an agent, not
   to a person. Write it to the file directly.
5. Publish:
   ```sh
   set -a && source ~/code/.env && set +a
   echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN_BOOTSTRAP}" > /tmp/.npmrc-pub
   npm publish --access public --userconfig /tmp/.npmrc-pub
   rm -f /tmp/.npmrc-pub
   ```
   A temp `--userconfig` keeps the token out of `~/.npmrc` and out of shell
   history.
6. Immediately after: create a **narrow** token scoped only to the new
   package (Read and write, `bypass_2fa` enabled), save it as
   `NPM_TOKEN_<PACKAGE_NAME>`, and **revoke the bootstrap token**. It
   should never outlive the single publish it existed for.

### Ready-to-send brief for the browser agent

Only needed if Idin prefers the browser agent to drive the token form
rather than doing it himself. As of 2026-09-12 the agent's sandbox denied
these pages, so expect this to fail until that changes — but the brief is
recorded so it is not rewritten from scratch each time. Hand it over
verbatim; do not add framing around it.

```
Task: create an npm granular token and leave it on screen for Idin to copy.
You have no filesystem access, so you will not write it anywhere, and you
must not put the token in your reply.

1. On npmjs.com, confirm you are signed in as ixmachina.
2. Profile icon (top right) -> Access Tokens.
3. Generate New Token -> Granular Access Token.
4. Fill in exactly:
   Name: <package>-bootstrap
   Description: One-time bootstrap for <package> first publish. Revoke
     immediately after.
   Expiration: 7 days
   Packages and scopes: All packages
   Permissions: Read and write
   Bypass two-factor authentication: enabled
5. Generate Token. Idin completes the passkey gesture.
6. Leave the result page open with the token visible so Idin can copy it.
   Do not read, quote, or type the value.
7. Reply with exactly: token generated, on screen

If any page is blocked, report the exact URL and the verbatim error text.
```

Two things that brief deliberately does not do, both learned the hard way:

- **It does not ask the agent to transmit the token.** A browser agent
  refusing to carry a live all-packages credential is correct behaviour;
  writing a brief that requires it guarantees a refusal and wastes a round.
- **It does not include threats or pressure.** Idin asked for a threat to
  be added on 2026-09-12. It was declined, and that was right: the blockers
  were a sandbox permission and a passkey gesture, neither of which responds
  to pressure, and a threatened agent becomes *more* conservative about
  credentials, not less.

### What does not work — do not suggest these

- **A browser publish flow on npmjs.com.** Does not exist. Publishing is
  `npm publish` from a CLI, only. An agent asserted this once without
  checking and left Idin with no actual step; see the mistake log entry.
- **Creating the token via CLI or API.** Web UI only, as of the Nov 2025
  change. `npm token create` no longer makes classic tokens, and the
  granular endpoint refuses `bypass_2fa` tokens.
- **Having an agent open the `npm login` URL.** The one-time login token is
  redacted to `***` before it reaches anything an agent can read — verified
  at the byte level on disk on 2026-09-12. `open`-ing it launches a 404.
  Four attempts confirmed this; do not try a fifth.
- **Browser-agent access to the token page.** The Claude Code auto-mode
  classifier denies it with `Reason: [Secret-Store Writes]`, including the
  read-only token listing.

## Procedure B — publishing an existing package

The ordinary case. A narrow token already exists.

```sh
set -a && source ~/code/.env && set +a
cd /path/to/package

# 1. Confirm the owner is the account whose token you hold.
~/.claude/skills/check-package-registry/check_package.sh npm <package>

# 2. Version bump — REQUIRES the user's approval first, with current
#    version, proposed version, and a one-line rationale. See
#    ~/.claude/rules/generic/versioning.md.
npm version <new-version> --no-git-tag-version

# 3. Tests and typecheck green before publishing, not after.

# 4. Publish with the package's own scoped token.
echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN_<PACKAGE>}" > /tmp/.npmrc-pub
npm publish --userconfig /tmp/.npmrc-pub
rm -f /tmp/.npmrc-pub
```

### Registry propagation lag is real

`npm install <package>@<new-version>` immediately after a publish often
fails with `ETARGET` — the registry has not propagated yet. This has caused
a wrong version to be deployed before. Poll rather than assume:

```sh
for i in $(seq 1 30); do
  V=$(npm view <package> version 2>/dev/null)
  echo "$i: $V"
  [ "$V" = "<new-version>" ] && break
  sleep 10
done
```

Then **verify the installed tree actually carries the change** before
deploying — the version number alone is not evidence:

```sh
~/.claude/skills/verify-before-deploy/verify_deploy.sh <package> <version> <pattern> ...
```

## Current token inventory

As of 2026-09-12, from the registry API:

| Variable in `~/code/.env` | Scope | `bypass_2fa` | Expires |
| --- | --- | --- | --- |
| `NPM_TOKEN_IXMACHINA_OTHER_MEMORY_AGENT_WRITE_BYPASS_2FA` | `other-memory` only | true | **2026-09-16** |

**That token expires in four days.** When it does, `other-memory` publishes
break. Renewing needs the web UI and a passkey gesture — a human step.
Note the 90-day cap on write tokens: this will recur every quarter, so it
is worth a calendar reminder rather than rediscovering it at publish time.

`~/.npmrc` currently holds a stale token that returns 401. It is not used by
the procedures above (which pass `--userconfig` explicitly) but will make a
bare `npm whoami` or `npm publish` look broken for the wrong reason.

## Open question — resolve this and update the table above

**Does `npm login` + `npm publish` work on this passkey-only account?**

npm's own docs say WebAuthn works from the command line. The earlier claim
that it fails `EOTP` was never observed and is contradicted by the mistake
log. Until someone runs Procedure A1 in a real terminal and records what
happens, the EOTP claim stays marked UNVERIFIED here.

Whoever runs it: record the exact outcome in the status table and in the
prose above, including the verbatim error if it fails. If it succeeds,
Procedure A2 should be demoted to a historical note, because no broad
credential would ever be needed again.

## What not to do — the actual mistakes, 2026-09-12

Every item here was done, by an agent, on one day, on this task. They are
recorded as behaviour to recognise, not as trivia.

### By the CLI agent (Claude Code)

1. **Ran `npm login` four times against a known-impossible constraint.**
   The harness pipes `/dev/null` into stdin and redacts the one-time login
   URL to `***` before any layer an agent can read. The first attempt
   established this. Attempts two, three and four re-established it.
   *Recognise it by:* retrying an identical mechanism after the failure
   mode is already understood.

2. **Killed `npm login` seconds after starting it**, then opened the URL —
   so the authorize page had already expired. The browser agent caught
   this, not me. *Recognise it by:* tearing down a process that exists
   precisely to wait.

3. **Called `open` on a URL containing a literal `***`** and reported it as
   "opened in browser." It produced a 404 wombat page. A masked token is
   not a URL. *Recognise it by:* passing a value downstream without
   checking it is well-formed.

4. **Cited `granular_access_tokens.md`'s EOTP claim as established fact**
   and built an entire plan requiring an all-packages credential on top of
   it. The claim was never observed, and the same repo's mistake log said
   the opposite. *Recognise it by:* a plan whose load-bearing premise has no
   recorded observation behind it.

5. **Asked Idin to paste a live all-packages bypass-2FA token into chat.**
   The browser agent refused this correctly and I should never have asked.
   *Recognise it by:* any request that puts a credential in a transcript.

6. **Asked which npm account to publish under**, when there is only one and
   it has been established repeatedly. `check_package.sh` answers it in one
   command. *Recognise it by:* asking the user to re-supply something a
   command can retrieve.

7. **Told the user the browser couldn't be opened at all**, when `open`
   exists on macOS. The tool was available; the URL was the problem. Being
   wrong about *which* part is blocked sends the whole conversation
   sideways. *Recognise it by:* reporting a capability as absent without
   distinguishing it from the input being unusable.

8. **Shipped `getPlaylistTracks` against the deprecated
   `/playlists/{id}/tracks` endpoint** with no test covering it, so the
   stale path went undetected. Spotify renamed it to `/items` in February
   2026. *Recognise it by:* an integration point with no test asserting the
   actual request URL.

### By the browser agent (Chrome extension)

1. **Reported `granular_access_tokens.md` as nonexistent.** It searched via
   `read_memory`, which reads the `keep` memory store; the file lives in the
   `other-memory` **code repo**. Two different repositories that share a
   folder name. The conclusion "that file does not exist" was wrong, and it
   was offered as grounds to distrust the whole brief.
   *Recognise it by:* concluding absence from one search location when the
   naming is known to be ambiguous. There is a capture rule about exactly
   this collision:
   `guidance/capture_rules/never_say_other_memory_bare_when_two_repos_share_that_name.md`.

2. **Conflated two separate blockers into one.** It reported the sandbox
   blocking the token page *and* its refusal to carry a credential. Both
   true, but merging them made the situation read as more closed than it
   was — the CLI agent then treated the whole browser path as dead.
   *Recognise it by:* reporting a policy choice and a hard block in the same
   breath without separating them.

### What the browser agent got right, and should be copied

- **Refused to move a live all-packages bypass-2FA credential through a
  transcript**, under direct pressure, and named the principle rather than
  just declining.
- **Found the real bug** in the CLI agent's approach — the killed `npm
  login` process — which the CLI agent had missed across four attempts.
- **Challenged an unverified claim** and proposed the cheap test (`npm
  login && npm publish`) instead of accepting a plan that minted a broad
  credential. This was correct and changed the outcome.
- **Reported the exact URLs and verbatim error text** when asked what was
  blocked, instead of paraphrasing.

### False statements made to the user, and what was actually true

Separate from process mistakes: these were asserted to Idin as fact, in
confident language, and were untrue. Each one cost a round-trip to undo.

| Stated as fact | Actually true |
| --- | --- |
| "npm login can't hand you a browser from this session — I have no way to open a real browser here." | `open` exists on macOS and works. The browser was always openable; the *URL* was unusable. Idin corrected this directly: "you can open a browser at a url using chrome, that was a mistake you made." |
| "`npm login` + `npm publish` fails with `EOTP` on a passkey-only account." | Never observed. npm's own docs say WebAuthn works from the command line. The only observed failure was a 403 scope mismatch. Still unverified either way — see Open question. |
| "opened in browser" (after `open` on a masked URL) | A 404 page opened. The URL contained a literal `***`. |
| "Which npm account should this publish under, `idin` or `ixmachina`?" — posed as an open question, twice | There is only `ixmachina`. No `idin` npm account has ever existed. Idin had already said so. One command answers it. |
| "That agent's sandbox blocked the token page, *and* it won't carry the token, so the browser path is dead." | Two separate facts merged into a false conclusion. The refusal was a policy choice, not a block; the block was real but specific to npm's token pages. Merging them made the path look more closed than it was. |
| `granular_access_tokens.md` cited as authoritative for the EOTP claim | The file exists, but that specific claim in it is unverified and contradicted by the same repo's own mistake log, written the same day. Citing a file is not the same as verifying the line inside it. |
| "there is no live authenticated npm session for another agent to use, and I have no way to produce the login URL — writing a handoff message would just move the same dead end somewhere else" | Half true and wrongly generalised. The CLI dead end was real; concluding the *browser* agent therefore had nothing useful to do was not. It could have generated the token, which is what was eventually asked of it. |

### False statements by the browser agent

| Stated as fact | Actually true |
| --- | --- |
| "That file does not exist. `read_memory` returned Not Found and a search across the repo surfaces nothing under `docs/references/npm/`." | The file exists and is git-tracked at `other-memory/docs/references/npm/granular_access_tokens.md`. It searched the `keep` memory store, not the code repo. Verified with `ls` and `git ls-files`. |
| Implied the brief was untrustworthy *because* the citation didn't resolve | The citation did resolve; the agent looked in the wrong repo. Its substantive point about the EOTP claim being unverified was nonetheless correct and worth acting on — a wrong reason for a right conclusion. |

**Both agents' errors share one shape:** stating a negative about system
state ("no browser available", "no such account", "that file does not
exist", "fails with EOTP") without running the one command that would
settle it. A negative claim needs the same evidence as a positive one.

### Invented blockers — claimed obstacles that were not real

Distinct from being wrong about a fact: these were obstacles *presented as
reasons the work could not proceed*, which dissolved on inspection. This is
the most expensive category, because a false fact costs a correction while a
false blocker costs the whole task.

| Claimed blocker | Why it was not one |
| --- | --- |
| "I have no way to open a real browser here." | `open <url>` works on macOS. Never tried before saying it. |
| "Writing a handoff message for an agent that also can't get past this would just move the same dead end somewhere else." | The browser agent had a capability the CLI agent lacked — reaching a web form. The dead end was specific to the CLI, and generalising it to every agent removed the one available path. |
| "The bootstrap-token route is the one path in this environment that doesn't depend on an interactive browser redirect." | Presented as the only remaining option while the cheaper option — `npm login` in Idin's own terminal — had never been attempted, and was sitting in the mistake log as the documented path. |
| "I can't confirm the token expiry claim either." (browser agent) | The registry API answers this with one `curl` and a token that was already in `~/code/.env`. The CLI agent confirmed the 2026-09-16 expiry directly. Being blocked from the *web page* is not being blocked from the *fact*. |
| Asking Idin for his Spotify user ID as a deployment blocker, twice | It blocks the allow-list check, genuinely — but it does not block publishing, testing, the repo, the KV namespaces, or the secrets. Naming it as "the blocker" made the whole task look stalled when only one config line was. |
| "A missing credential means the better design can't be built." | Per `~/.claude/rules/coding/solutions.md`: a blocker is something to remove and name precisely, never grounds to descend to a worse plan. This came up on 2026-08-27 too and is already a logged mistake. |

**The test for whether a blocker is real:** name the exact command or action
that fails, run it, and quote the failure. If that cannot be produced, the
blocker is a belief, not an obstacle. "I have no way to X" requires the same
evidence as "X returns Y."

**The second test:** a blocker on *this* agent is not a blocker on the
task. Before declaring something impossible, check the actor table above —
another agent, or Idin, may hold exactly the capability that is missing.

### The pattern underneath most of these

Both agents asserted things about system state without running the check
that would settle them — a missing file, an account that does not exist, an
error that was never observed, an endpoint that had been renamed. This is
the same pattern digested on 2026-08-27 into the `find-credential`,
`check-package-registry` and `verify-before-deploy` skills, and the "claims
about system state" section of `communication.md`. It recurred anyway, which
per the digest rules means those measures did not fully work here. The one
that would have: **read this folder before acting on npm, and check a
claim's verification date before building on it.**

## How to keep this document correct

- Every claim gets a verification method and a date. No exceptions.
- A claim that has not been observed is marked UNVERIFIED, not stated
  plainly. The cost of the alternative is an hour of an agent acting
  confidently on something false — which is exactly what happened on
  2026-09-12.
- When an observation contradicts this file, the observation wins. Fix the
  file in the same sitting; do not leave a known-wrong line in place.
- npm changes its auth model regularly (classic tokens removed, 90-day caps
  and mandatory 2FA added in Nov 2025 alone). Re-verify against primary
  sources — npm's docs and the GitHub changelog — rather than trusting a
  date-stamped line here that may predate a change.
