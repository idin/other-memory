/**
 * How this server talks to GitHub.
 *
 * One place, because the options matter and were previously repeated at
 * every call site — `new Octokit({ auth })`, a dozen times, each free to
 * drift from the others.
 */

import { Octokit } from "octokit";

/**
 * Build an Octokit that fails fast when GitHub refuses.
 *
 * The `octokit` package bundles the retry and throttling plugins and enables
 * them by default. Their behaviour on a rate limit is to *wait for the
 * reset* — up to an hour — rather than return an error. Inside a Worker that
 * is indistinguishable from a hang: the request never completes, the gateway
 * answers 504, the client retries, and each retry starts another request
 * that will also sit and wait. That is how an exhausted quota turned into
 * every tool timing out on 2026-08-26, and why the server's own backoff
 * never ran — the error it backs off from was being swallowed a layer below.
 *
 * Waiting is a reasonable default for a script. It is the wrong one for a
 * request with a caller on the other end, who is better served by "the rate
 * limit is exhausted, try after 23:44" than by silence.
 *
 * @param token - The token to authenticate with.
 * @returns An Octokit that surfaces rate limits instead of sleeping on them.
 */
export function githubClient(token: string): Octokit {
  return new Octokit({
    auth: token,
    retry: { enabled: false },
    throttle: {
      // Both callbacks must return false, which tells the plugin not to
      // retry. Returning nothing would fall back to its own judgement.
      onRateLimit: () => false,
      onSecondaryRateLimit: () => false,
    },
  });
}
