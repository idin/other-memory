import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { MemoryRepoConfig } from "../../src/memory_repo";

/**
 * Configuration for the integration tests, and the guards around it.
 *
 * These tests act on a real GitHub repository. Two things follow from that,
 * and both are enforced here rather than left to whoever runs them: the tests
 * must refuse to run without a token instead of quietly skipping, and they
 * must refuse to run against anything that is not the sandbox.
 */

const TOKEN_VARIABLE = "GITHUB_TOKEN_OTHER_MEMORY_TEST_SANDBOX";
const REPO_VARIABLE = "OTHER_MEMORY_TEST_SANDBOX_REPO";
const DEFAULT_REPO = "idin/other-memory-test-sandbox";

/**
 * Read the sandbox configuration.
 *
 * @returns Repository coordinates and the token to reach them with.
 * @throws Error if the token is absent, or if the configured repository does
 *   not look like a sandbox.
 */
export function sandboxConfig(): MemoryRepoConfig {
  const token = process.env[TOKEN_VARIABLE] ?? readFromEnvFile(TOKEN_VARIABLE);
  if (!token) {
    throw new Error(
      `${TOKEN_VARIABLE} is not set. These tests act on a real repository and ` +
        `cannot be faked, so they fail rather than skip: a skipped test reports ` +
        `success without having checked anything. Create a fine-grained token ` +
        `scoped to ${DEFAULT_REPO} with contents read/write, and put it in ` +
        `~/code/.env.`,
    );
  }

  const repository = process.env[REPO_VARIABLE] ?? DEFAULT_REPO;
  assertIsSandbox(repository);

  const [owner, repo] = repository.split("/");
  return { owner, repo, branch: "main", token };
}

/**
 * Read a value from the shared environment file.
 *
 * The file is the project's single home for credentials, but reaching a test
 * runner from it depends on the line carrying an `export` prefix and on the
 * shell having been reloaded since. Both are easy to get wrong, and the
 * failure looks identical to having no token at all — which sends whoever hits
 * it off creating a second one they did not need.
 *
 * Reading the file directly removes that whole class of confusion. The
 * environment still wins when it is set, so overriding for one run works as
 * expected.
 *
 * @param name - The variable to look for.
 * @returns Its value, or undefined when the file has no such line.
 */
function readFromEnvFile(name: string): string | undefined {
  const envPath = join(homedir(), "code", ".env");
  if (!existsSync(envPath)) {
    return undefined;
  }
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
    if (match && match[1] === name) {
      return match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}

/**
 * Refuse any repository that is not recognisably a sandbox.
 *
 * The tests delete files and rewrite history. Pointed at the wrong repository
 * they would do that to somebody's actual memory, and the only thing standing
 * between the two is an environment variable.
 *
 * @param repository - The `owner/name` the tests would act on.
 * @returns Nothing.
 * @throws Error if the repository is not a sandbox.
 */
export function assertIsSandbox(repository: string): void {
  if (/(^|\/)keep$/.test(repository)) {
    throw new Error(
      `Refusing to run against '${repository}': that is the real memory repository.`,
    );
  }
  if (!repository.includes("sandbox")) {
    throw new Error(
      `Refusing to run against '${repository}': the name must contain ` +
        `'sandbox', so a mistyped repository cannot be written to.`,
    );
  }
}

/**
 * Restore the sandbox to the fixture.
 *
 * Runs before each test rather than once for the file, because these tests
 * mutate the repository and one of them rewrites its history. Sharing state
 * between them would make the order they run in part of what is being tested.
 *
 * @returns Nothing.
 */
export async function resetSandbox(): Promise<void> {
  execFileSync("./scripts/sandbox/reset.sh", {
    cwd: new URL("../..", import.meta.url).pathname,
    encoding: "utf8",
    stdio: "pipe",
  });
  await waitForFixture();
}

/**
 * Wait until the API agrees the fixture is back.
 *
 * The reset pushes over git, and the tests read over the REST API. Those are
 * not the same path into GitHub, and a push that git has accepted is not
 * always a push the API is serving yet — particularly after a run of rapid
 * writes, which GitHub throttles.
 *
 * Without this the tests fail intermittently and in a way that reads like a
 * bug in the library: a file that was definitely restored appears missing,
 * a different test each time. Polling for a known file removes the guesswork.
 *
 * @returns Nothing.
 * @throws Error if the fixture has not appeared within the timeout.
 */
async function waitForFixture(): Promise<void> {
  const config = sandboxConfig();
  const deadline = Date.now() + 30_000;

  // Every file a test reads, moves or deletes. Waiting on one of them is not
  // enough: the push restores them together, but the API serves them
  // independently, and a test that deletes a file the API has not yet
  // restored sees the delete apparently do nothing.
  const required = [
    FIXTURE_CORE_FACTS,
    FIXTURE_INSTRUCTIONS,
    FIXTURE_MESSAGE,
    "other-memory/facts/biscuit.md",
    "other-memory/facts/home/kitchen.md",
  ];

  // Anything a test creates must be gone again, or the next run's "create a
  // file that did not exist" fails against a file that still does.
  // Every path a test creates belongs here. A leftover from the previous run
  // makes the next one fail against state it did not create, and the failure
  // points at the wrong thing entirely.
  const forbidden = [
    "other-memory/facts/rivers.md",
    "other-memory/facts/person.md",
    "other-memory/facts/added_later.md",
    "other-memory/facts/written_meanwhile.md",
    "other-memory/facts/encoding_check.md",
    "other-memory/facts/rebuild_check.md",
    "other-memory/facts/delete_check.md",
    "other-memory/facts/search_check.md",
    "other-memory/facts/superseded_check.md",
  ];

  while (Date.now() < deadline) {
    const [present, absent] = await Promise.all([
      Promise.all(required.map((path) => statusOf(config, path))),
      Promise.all(forbidden.map((path) => statusOf(config, path))),
    ]);
    if (present.every((status) => status === 200) && absent.every((status) => status === 404)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    "The sandbox fixture did not settle within 30s. The reset reported " +
      "success, so this is GitHub not yet serving what git accepted.",
  );
}

/**
 * Ask the API for a path's status.
 *
 * @param config - Where to ask.
 * @param path - The path to look for.
 * @returns The HTTP status, 200 when the file is there and 404 when it is not.
 */
async function statusOf(config: MemoryRepoConfig, path: string): Promise<number> {
  const response = await fetch(
    `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${path}` +
      `?ref=${config.branch}`,
    {
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/vnd.github+json",
        // A cached answer from before the push is exactly the one that must
        // not be believed here.
        "Cache-Control": "no-cache",
      },
    },
  );
  return response.status;
}

/**
 * Retry until the API reflects a write that has already been accepted.
 *
 * GitHub acknowledges a write before every replica of the contents API is
 * serving it, so a read taken immediately afterwards can return what was there
 * a moment ago. The library is right to make the write and right to make the
 * read; there is simply a window in between, and only a test reading its own
 * writes as fast as it can manage is narrow enough to fall into it.
 *
 * Retrying here rather than adding delays inside the library keeps the
 * workaround where the problem actually is. Production callers are an agent
 * and a person, and neither reads a file microseconds after writing it.
 *
 * @param check - What to assert. Throwing means not yet.
 * @returns Whatever `check` returns once it stops throwing.
 * @throws The last error, if the window never closes.
 */
export async function eventually<Result>(check: () => Promise<Result>): Promise<Result> {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw lastError;
}

/** A path in the fixture that every test can rely on existing. */
export const FIXTURE_CORE_FACTS = "other-memory/facts/core.md";

/** The read-only file, which no write may touch. */
export const FIXTURE_INSTRUCTIONS =
  "other-memory/guidance/instructions/standing_instructions.md";

/** The seeded todo, for the revert tests. */
export const FIXTURE_TODO =
  "other-memory/work/todos/open/2026-01-15_replace_extractor_fan.md";

/** The seeded message, for the inbox tests. */
export const FIXTURE_MESSAGE =
  "other-memory/messages/inbox/ada/2026-02-03T09-14-22-000Z_kip_river_gauge_data.md";
