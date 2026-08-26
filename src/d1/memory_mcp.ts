/**
 * A `MemoryMCP` that wires itself to D1 and Workers AI whenever the bindings
 * exist, and works without them.
 *
 * Every deployment that has these bindings wants the same wiring — there is
 * no per-deployment choice being made in `init` below, only "is the binding
 * there". That is what makes this worth shipping as a ready subclass rather
 * than documentation a deployment copies: the copy would be identical.
 *
 * A deployment that wants something this does not do — a different sink, an
 * extra tool — still subclasses `MemoryMCP` directly, per the README.
 */

import { MemoryMCP, type Env, type Embedder } from "../index";
import { workersAiEmbedder, type WorkersAi } from "../embeddings";
import {
  d1FailureSink,
  d1MemoryIndex,
  d1RawSearchSink,
  d1RelevanceSink,
  d1UsageSink,
} from "./index";

/**
 * What a D1-backed deployment binds, beyond what the base server requires.
 *
 * Both optional, for the same reason: the server must keep working without
 * them. Without `OTHER_MEMORY_DATABASE`, failures go to the console and
 * usage/search telemetry is discarded. Without `AI`, search matches words
 * rather than meaning, and says so rather than returning a partial answer as
 * though it were the whole one.
 */
export type D1Env = Env & {
  OTHER_MEMORY_DATABASE?: D1Database;
  AI?: WorkersAi;
};

/** A `MemoryMCP` that wires D1 storage and Workers AI embedding in when bound. */
export class D1MemoryMCP extends MemoryMCP {
  declare env: D1Env;

  async init(): Promise<void> {
    if (this.env.OTHER_MEMORY_DATABASE) {
      this.failureSink = d1FailureSink(this.env.OTHER_MEMORY_DATABASE);
      this.usageSink = d1UsageSink(this.env.OTHER_MEMORY_DATABASE);
      // Shared rather than per-session: the index is a pure function of the
      // commit, so whoever builds at a commit builds it for every session.
      this.memoryIndex = d1MemoryIndex(this.env.OTHER_MEMORY_DATABASE, {
        now: () => Date.now(),
      });
      this.relevanceSink = d1RelevanceSink(this.env.OTHER_MEMORY_DATABASE);
      this.rawSearchSink = d1RawSearchSink(this.env.OTHER_MEMORY_DATABASE, {
        now: () => Date.now(),
        roundId: () => crypto.randomUUID(),
      });
    }

    await super.init();

    // The tools that read the sinks above back out. Registered only when
    // there is a database for them to read — a deployment with none should
    // not see tools that can only ever report "no database bound".
    if (this.env.OTHER_MEMORY_DATABASE) {
      await this.registerD1Tools(this.env.OTHER_MEMORY_DATABASE);
    }
  }

  protected embedder(): Embedder | null {
    if (!this.env.AI) {
      return null;
    }
    return workersAiEmbedder(this.env.AI, {
      usageSink: this.usageSink,
      trigger: "search",
      now: () => Date.now(),
    });
  }
}
