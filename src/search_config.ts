/**
 * Every tunable number search uses, in one place.
 *
 * These are decisions rather than facts. A quota, a threshold, a batch size —
 * each could sensibly be different, and the test for whether something belongs
 * here is exactly that: could this value ever reasonably change? If yes it is
 * configuration, not a constant buried in the function that happens to use it.
 *
 * Values that are *derivable* from these are deliberately absent. The
 * candidate pool sizes N and M are computed from the quotas rather than
 * stored, because a stored copy drifts from the numbers it was meant to
 * follow the first time somebody edits one and not the other.
 */

/**
 * How many results each tier of the cascade may contribute.
 *
 * The cascade exists because recall is the goal and ranking is not. Search
 * returns every exact match, then fills each remaining tier from what earlier
 * tiers did not already claim, so a chunk appears once — at its strongest
 * method — and no quota is spent on chunks another method already returned.
 *
 * Set wide on purpose. Idin's rule: a hundred results of which ninety are
 * useless is fine, ten results missing the one that mattered is not. Precision
 * is recoverable by whoever reads the results; recall is not recoverable at
 * all, because nothing downstream can retrieve what was never returned.
 */
export type SearchQuotas = {
  /** `starts_with`, ordered shortest chunk first. */
  startsWith: number;
  /** `ends_with`, ordered shortest chunk first. */
  endsWith: number;
  /** `contains`, ordered shortest chunk first. */
  contains: number;
  /**
   * `contained_by` — the chunk appears inside the query — shortest first.
   *
   * The reverse direction of `contains`, and it finds what `contains` cannot:
   * a full question passes over the short entries that answer it, because no
   * chunk holds the whole question. Asking "what is Frodo's neck measurement
   * for a collar" reaches "Neck: 7.5 inches" only this way.
   */
  containedBy: number;
  /** Fuzzy, ordered by score. */
  fuzzy: number;
  /** Semantic, ordered by cosine similarity. */
  cosine: number;
};

/**
 * The default quotas.
 *
 * Roughly 140 results against a store of about 380 chunks — a third of it, for
 * a query that hits every tier. Most queries hit far fewer.
 *
 * `contains` and `cosine` are the widest because they are the two that find
 * things the others cannot: `contains` catches any wording that literally
 * appears, and `cosine` catches wording that does not appear at all. The
 * anchored tiers are narrower because a chunk matching `starts_with` almost
 * always also matches `contains`, so their quota buys less new coverage.
 */
export const DEFAULT_SEARCH_QUOTAS: SearchQuotas = {
  startsWith: 15,
  endsWith: 15,
  contains: 40,
  containedBy: 20,
  fuzzy: 30,
  cosine: 40,
};

/**
 * Exact matches are never capped.
 *
 * A chunk whose entire text is the query is as good as a match gets, and there
 * are never many — capping them would discard the best results to make room
 * for worse ones. Stated as a named value rather than left implicit so the
 * decision is visible.
 */
export const EXACT_MATCHES_ARE_UNCAPPED = true;

/**
 * How wide the fuzzy candidate pool must be before the cascade runs.
 *
 * Every chunk has a fuzzy score, so the pool has to be cut somewhere, and it
 * is cut *before* earlier tiers take their share. If it were cut to exactly
 * the quota, any candidate also claimed by an earlier tier would leave the
 * fuzzy quota short — the pool would shrink by however much overlapped, and
 * genuinely fuzzy-only matches would be lost to make room for chunks already
 * returned.
 *
 * So the pool is the quota plus the most that earlier tiers could take.
 *
 * @param quotas - The tier quotas.
 * @param exactCount - How many exact matches were found, known by this point.
 * @returns How many fuzzy candidates to keep before the cascade.
 */
export function fuzzyPoolSize(
  quotas: SearchQuotas,
  exactCount: number,
): number {
  return (
    quotas.fuzzy
    + exactCount
    + quotas.startsWith
    + quotas.endsWith
    + quotas.contains
    + quotas.containedBy
  );
}

/**
 * How wide the semantic candidate pool must be.
 *
 * Same reasoning as {@link fuzzyPoolSize}, one tier further down: everything
 * above cosine in the cascade can take from its pool, fuzzy included.
 *
 * @param quotas - The tier quotas.
 * @param exactCount - How many exact matches were found.
 * @returns How many semantic candidates to keep before the cascade.
 */
export function cosinePoolSize(
  quotas: SearchQuotas,
  exactCount: number,
): number {
  return fuzzyPoolSize(quotas, exactCount) + quotas.cosine;
}

/**
 * The shortest query token worth matching fuzzily.
 *
 * Jaro-Winkler is unreliable below this: with three characters a single
 * agreement moves the score a long way and the prefix bonus covers most of the
 * string. Measured on the real store, "Mid-40s" — tokenizing to "mid" and
 * "40s" — scored 0.956 against a message about workbenches, higher than a
 * genuine typo scored against the word it meant.
 *
 * Short tokens are still matched exactly and by substring, which is the only
 * way a three-letter token means anything.
 */
export const MINIMUM_FUZZY_TOKEN_LENGTH = 4;

/**
 * How many files to index per search.
 *
 * A Worker may make a bounded number of outbound calls per invocation — 50 on
 * the free plan — and every service call counts: GitHub, the embedding model,
 * and the D1 database.
 *
 * Per file, a rebuild round spends three subrequests: one GitHub blob read,
 * one embedding call, one D1 `replaceFile`. The round also has a fixed
 * overhead of roughly a dozen — the head commit, the built-commit lookup, the
 * rebuild-plan comparison, the tree listing, and the index loads before and
 * after. So the ceiling is `12 + 3n <= 50`, i.e. `n <= 12`, and 12 was
 * originally set right at that edge.
 *
 * It failed there on 2026-09-10: a post-commit reconcile ran a full round of
 * 12 and crossed the limit — the fixed overhead had crept up and the embed
 * call per file was not counted in the original estimate. 8 leaves real
 * headroom (`12 + 24 = 36`) and a slightly larger store still finishes across
 * a few more rounds, which the alarm drives automatically.
 */
export const FILES_INDEXED_PER_SEARCH = 8;

/**
 * How long to wait before an alarm continues an incomplete index build.
 *
 * Short enough that a large store finishes soon after the search that
 * started it, long enough that a very large store does not stack many small
 * Worker invocations back to back for no benefit. A Durable Object alarm
 * gets its own fresh subrequest budget on each firing, so the constraint
 * here is pacing, not the subrequest limit `FILES_INDEXED_PER_SEARCH`
 * already exists to respect.
 */
export const ALARM_RETRY_DELAY_SECONDS = 5;

/**
 * How long to wait after the GitHub API refuses for rate reasons.
 *
 * The ordinary five seconds is pacing for a build that is making progress.
 * A rate-limited build is making none, and retrying at that interval spends
 * the quota it is waiting on — which is how a rebuild exhausted an hour of
 * GitHub's allowance on 2026-08-26 and left every tool hanging.
 *
 * A minute is chosen against GitHub's own reset granularity: primary limits
 * reset hourly, secondary ones clear in tens of seconds, so this recovers
 * quickly from the common case without hammering the rare one.
 */
export const RATE_LIMITED_RETRY_DELAY_SECONDS = 60;

/**
 * How many neighbouring chunks may be attached to one result.
 *
 * A chunk opening with "It" or "They" depends on the one before it, and
 * returning it alone says nothing. Each attached neighbour is context someone
 * has to read, so this is small — a result needing more than a couple of them
 * usually means the file wanted splitting, which the layout rule already asks
 * for.
 */
export const MAXIMUM_SIBLINGS_PER_HIT = 2;

/**
 * How much of a chunk to show in a result.
 *
 * Results are excerpts rather than whole chunks because the point of a wide
 * result set is to let a reader judge relevance cheaply, then read what looks
 * promising in full. A hundred full chunks would defeat the purpose of
 * returning a hundred.
 */
export const EXCERPT_CHARACTERS = 240;
