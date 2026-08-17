/**
 * Verifying that an agent using a name is the same one that used it before.
 *
 * Names are free-form and otherwise unenforced (see `agent_names.ts`): any
 * session can call itself "Ada", and nothing distinguishes it from any other
 * session doing the same, because MCP exposes no stable session identity to
 * a server. A token does not solve that — it cannot prove which physical
 * session is asking — but it does mean a name with a token on record can
 * only be used by whoever was given that token, so an unrelated session
 * cannot accidentally or carelessly collide with a name already in use.
 *
 * Tokens are written directly by the user, via a normal commit to
 * `HIDDEN_FROM_AGENTS_PREFIX` — no tool creates, writes, or returns one.
 * This module only ever reads that file and compares.
 */

import { Octokit } from "octokit";

import { normalizeAgentName } from "./agent_names";
import { HIDDEN_FROM_AGENTS_PREFIX } from "./layout";
import type { MemoryRepoConfig } from "./memory_repo";
import { decodeBase64 } from "./base64";

/** Where every name's token is recorded, one `name: token` pair per line. */
export const AGENT_NAME_TOKENS_PATH = `${HIDDEN_FROM_AGENTS_PREFIX}agent_name_tokens.md`;

/**
 * Wrapper markers around a token value, chosen to be unmistakable and to
 * essentially never occur in ordinary prose or code — so a scanner over the
 * rest of the store can spot a token that has leaked outside
 * `HIDDEN_FROM_AGENTS_PREFIX` by searching for these markers alone.
 */
const TOKEN_OPEN = "«agent_token_start:";
const TOKEN_CLOSE = ":agent_token_end»";

/** Wrap a raw token value in its recognisable markers. */
export function wrapAgentToken(value: string): string {
  return `${TOKEN_OPEN}${value}${TOKEN_CLOSE}`;
}

/**
 * Pull the raw value out of a wrapped token, or null if the text is not a
 * wrapped token at all.
 */
export function unwrapAgentToken(wrapped: string): string | null {
  const trimmed = wrapped.trim();
  if (!trimmed.startsWith(TOKEN_OPEN) || !trimmed.endsWith(TOKEN_CLOSE)) {
    return null;
  }
  return trimmed.slice(TOKEN_OPEN.length, trimmed.length - TOKEN_CLOSE.length);
}

/**
 * Every name on record, keyed by its normalized form. Parsed from
 * `name: token` lines — blank lines and lines that do not parse are
 * skipped rather than failing the whole read, so one malformed line does
 * not lock out every name.
 */
async function readRecordedTokens(
  config: MemoryRepoConfig,
): Promise<Map<string, string>> {
  const octokit = new Octokit({ auth: config.token });
  let content: string;
  try {
    const response = await octokit.rest.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path: AGENT_NAME_TOKENS_PATH,
      ref: config.branch,
    });
    const file = response.data;
    if (Array.isArray(file) || file.type !== "file") {
      return new Map();
    }
    content = decodeBase64(file.content);
  } catch (error) {
    // No file yet means no name has a token on record.
    if ((error as { status?: number }).status === 404) {
      return new Map();
    }
    throw error;
  }

  const byKey = new Map<string, string>();
  for (const line of content.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const name = line.slice(0, separator).trim();
    const wrapped = line.slice(separator + 1).trim();
    const value = unwrapAgentToken(wrapped);
    if (name.length === 0 || value === null) {
      continue;
    }
    byKey.set(normalizeAgentName(name), value);
  }
  return byKey;
}

export type TokenVerdict =
  | { outcome: "verified" }
  | { outcome: "no_token_on_record" }
  | { outcome: "token_mismatch" };

/**
 * Check a name and token against what is on record.
 *
 * Every name now requires a token — there is no unrestricted path for a
 * name that predates this file or was never given one. The token value
 * itself is never returned in the verdict, whatever the outcome.
 *
 * @param config - Where the memory lives.
 * @param name - The name being used, in whatever form the caller typed it.
 * @param providedToken - The wrapped token the caller supplied.
 * @returns Whether the name has a token on record and, if so, whether the
 *   provided token matches it.
 */
export async function verifyAgentNameToken(
  config: MemoryRepoConfig,
  name: string,
  providedToken: string,
): Promise<TokenVerdict> {
  const recorded = await readRecordedTokens(config);
  const key = normalizeAgentName(name);
  const expected = recorded.get(key);

  if (expected === undefined) {
    return { outcome: "no_token_on_record" };
  }

  // Required, not merely accepted: a bare, unwrapped value is rejected the
  // same as a wrong one, so every real token in circulation is always
  // wrapped and therefore always greppable.
  const provided = unwrapAgentToken(providedToken);
  if (provided === null || !timingSafeEqual(expected, provided)) {
    return { outcome: "token_mismatch" };
  }
  return { outcome: "verified" };
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
