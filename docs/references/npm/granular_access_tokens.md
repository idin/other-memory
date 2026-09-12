# Granular access tokens

How npm's package-scoped tokens actually work, and the trap they set for a
brand-new package name.

> **Superseded 2026-09-12 by
> [`publishing_a_new_package.md`](publishing_a_new_package.md).** Read that
> first. This file's claim that `npm login` + `npm publish` fails with
> `EOTP` on a passkey-only account is **disproven** — `musix-box@0.1.0`
> published that way on 2026-09-12. It contradicted npm's own 2FA
> documentation and sent an agent down a wrong path for an hour. The
> corrections are marked inline below. The scoping and chicken-and-egg
> material here is still accurate.

## The scoping model

`npm token create` (the CLI command) cannot create a granular, per-package
token — it only creates account-wide read-only or publish tokens. Granular
tokens, scoped to one or more specific package names, are created through
npmjs.com's web UI only.

A granular token's scope is fixed at creation time to an explicit list of
package names (`"scopes": [{"name": "@ixmachina/memory", "type": "package"}]`
in the registry's own token metadata). There is no CLI or API call that edits
an existing token's scope — a token scoped to one package name cannot be
repointed at another. Publishing a *different* package with it fails with
`403 Forbidden`, not a clearer scope-mismatch error.

## The chicken-and-egg for a new package

npmjs.com's granular-token UI can only scope a token to a package that
**already exists on the registry**. A package that has never been published
cannot appear in that picker.

So the very first publish of a brand-new package name cannot go through a
granular token scoped to that package — there is nothing yet to scope it to.
That first publish has to happen some other way (an authenticated interactive
session, e.g. `npm login` + OTP, or the npmjs.com web publish flow), after
which a granular token can be created scoped to the now-existing package, for
every publish after the first.

This is the same shape as the fine-grained GitHub PAT problem, and it is not
solvable by choosing a different kind of token — it is a one-time,
unavoidable bootstrap step for any new package name, not a symptom of doing
something wrong.

## What this means in practice

- Renaming a published package (new name, not just new version) means the old
  package's scoped token does **not** carry over — a new token, scoped to the
  new name, has to be created after the new name's first publish.
- The first publish under a new name needs an authenticated human, not an
  agent holding only a scoped token — there is no token that could exist yet
  which would let an agent do it unattended.
- **There is no npm publish flow on npmjs.com itself.** Publishing only
  happens via `npm publish` from an authenticated CLI. Do not suggest a
  browser-based publish path — it does not exist. (Confirmed by checking
  `docs.npmjs.com/cli/v10/commands/npm-publish`, which documents no such
  feature.)
- ~~2FA-via-passkey-only accounts (no TOTP) cannot supply `--otp=<code>` to
  `npm publish` — `npm login` succeeds via passkey, but `npm publish` still
  demands a TOTP code the account cannot produce, and fails with `EOTP` even
  after a successful login.~~

  **Struck 2026-09-12. DISPROVEN — not merely unverified.** Idin ran `npm login` then `npm publish --access public` and `musix-box@0.1.0` published successfully on this passkey-only account. npm's own 2FA
  documentation states: "security-key with WebAuthn can be used for
  authentication from both the web and the command line, but it can only be
  configured from the web." The only failure actually observed was
  `403 Forbidden` from a *scope* mismatch (a token scoped to `other-memory`
  publishing `musix-box`), which says nothing about OTP. `keep`'s mistake
  log entry from this same day
  (`2026-08-16_told_idin_to_publish_via_a_web_ui_that_does_not_exist.md`)
  states the correct path is "`npm login` (passkey works interactively)
  followed by `npm publish`" — which is now the confirmed behaviour. See
  `publishing_a_new_package.md` for the verified procedure.

## The bootstrap method

**"Proven" was overstated — corrected 2026-09-12.** This worked once for
`@ixmachina/memory`, which shows it is *sufficient*, not that it is
*necessary*: nobody ever tested whether the simpler `npm login` path would
also have worked. Treat this as the fallback described in
`publishing_a_new_package.md` Procedure A2, not the default.

1. On npmjs.com, while logged in: profile icon (top right) → **Access
   Tokens** → **Generate New Token** → **Granular Access Token**.
2. Set packages/scopes to **"All packages"** (the new package cannot be
   selected individually since it does not exist yet), permissions to
   **Read and write**, and enable **bypass two-factor authentication** on
   the same form. Click **Generate Token** and copy it immediately — it is
   shown once only. This is a one-time bootstrap token, used once.
3. Use that token for the **first** `npm publish` of the new package name
   (`npm publish --access public --userconfig <temp .npmrc>`). Note the
   original rationale here — "this is what actually avoids the `EOTP`
   error" — was wrong: there is no `EOTP` error to avoid. `bypass_2fa` is
   indeed a token property, but an interactive `npm login` session does not
   need it.
4. Once the package exists on the registry, go back to npmjs.com and create
   a **second**, narrowly-scoped token — `bypass_2fa: true`, scoped only to
   the new package name — mirroring exactly how the old package's token was
   made.
5. Revoke the broad bootstrap token from step 2. It should never outlive the
   one publish it was needed for.
6. Save the new narrow token to `~/code/.env` alongside the account's other
   `NPM_TOKEN_*` entries, following the same naming convention.

## Source

Observed directly against the `ixmachina` npm account, 2026-08-16 —
`GET https://registry.npmjs.org/-/npm/v1/tokens` (with a valid token) returns
each token's own `scopes` array, which is where the `@ixmachina/memory`-only
scoping was confirmed rather than assumed.
