/**
 * Optional D1-backed storage for `other-memory`.
 *
 * Importing from `other-memory/d1` is the only way any of this loads — the
 * base server has no D1 dependency and works without a database. A
 * deployment that has a D1 binding wires these into `failureSink`,
 * `usageSink`, `memoryIndex` and `rawSearchSink` in its own subclass, then
 * calls `registerD1Tools` from `init()` if it also wants the tools that read
 * them back.
 */

export { d1FailureSink, recentFailures } from "./failure_sink";
export { d1UsageSink, usageSince, startOfUtcDay } from "./usage_sink";
export { d1RelevanceSink, judgmentCounts } from "./relevance_sink";
export { d1RawSearchSink } from "./raw_search_sink";
export {
  d1MemoryIndex,
  MAX_CARRY_FORWARD_EXCLUSIONS,
} from "./memory_index";
