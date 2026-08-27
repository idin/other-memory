import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  ALLOWED_EXTENSIONS,
  DECISION_LOG_PATTERN,
  INSTRUCTIONS_PREFIX,
  NAMESPACE,
  isWithinNamespace,
} from "../src/layout";

/**
 * The fixture must sit on the layout the code actually enforces.
 *
 * On 2026-08-27 it did not. A layout reorg moved instructions, decisions and
 * capture rules under `guidance/`, and the fixture tree was left on the old
 * shape. Two integration tests assert that the read-only guard refuses writes
 * to the instructions folder; because the fixture's copy sat outside the
 * prefix the guard protects, both writes succeeded:
 *
 *     AssertionError: promise resolved "{ …(3) }" instead of rejecting
 *
 * Those tests exist to prove a guard holds. Once the fixture drifted they
 * stopped exercising the guard and began exercising an unguarded path — and
 * had the assertions been written the other way round, the suite would have
 * stayed green while testing nothing at all.
 *
 * So the fixture is checked against the layout constants rather than against a
 * copy of the expected paths. A second list would drift the same way the first
 * one did.
 */
describe("the test fixture matches the layout the code enforces", () => {
  const fixtureRoot = join(import.meta.dirname, "fixture");

  function walk(directory: string): string[] {
    const found: string[] = [];
    for (const name of readdirSync(directory)) {
      const full = join(directory, name);
      if (statSync(full).isDirectory()) {
        found.push(...walk(full));
      } else {
        found.push(full.slice(fixtureRoot.length + 1));
      }
    }
    return found;
  }

  const paths = walk(fixtureRoot);

  test("the fixture is not empty", () => {
    // Guards the guard: a walk that silently found nothing would make every
    // assertion below pass without checking anything.
    expect(paths.length).toBeGreaterThan(0);
  });

  test("every fixture file is inside the namespace", () => {
    for (const path of paths) {
      expect(isWithinNamespace(path), `${path} is outside ${NAMESPACE}`).toBe(
        true,
      );
    }
  });

  test("every fixture file uses an allowed extension", () => {
    for (const path of paths) {
      const allowed = ALLOWED_EXTENSIONS.some((extension) =>
        path.endsWith(extension),
      );
      expect(allowed, `${path} has a disallowed extension`).toBe(true);
    }
  });

  test("the read-only fixture file is inside the guarded prefix", () => {
    // The exact drift that disarmed the guard. The fixture must hold a file
    // the instructions guard actually covers, or the tests asserting that
    // guard are testing an unprotected path.
    const guarded = paths.filter((path) =>
      path.startsWith(INSTRUCTIONS_PREFIX),
    );
    expect(guarded.length).toBeGreaterThan(0);
  });

  test("the constant the integration tests use points inside the fixture", () => {
    // The fixture tree and the constant naming it moved separately last time.
    const sandbox = readFileSync(
      join(import.meta.dirname, "integration", "sandbox.ts"),
      "utf8",
    );
    const declared = sandbox.match(
      /FIXTURE_INSTRUCTIONS\s*=\s*\n?\s*"([^"]+)"/,
    );
    expect(declared, "FIXTURE_INSTRUCTIONS not found").not.toBeNull();
    const path = declared![1];
    expect(path.startsWith(INSTRUCTIONS_PREFIX)).toBe(true);
    expect(paths).toContain(path);
  });

  test("every path the sandbox reset script copies exists in the fixture", () => {
    // The reset script names fixture folders literally. When the fixture moved
    // and the script did not, every integration test failed at setup with
    // "cp: .../other-memory/instructions: No such file or directory" — the
    // same drift as the fixture itself, one file further out.
    const script = readFileSync(
      join(import.meta.dirname, "..", "scripts", "sandbox", "reset.sh"),
      "utf8",
    );
    const copied = [
      ...script.matchAll(/fixture_directory\/other-memory\/([^"]+)"/g),
    ].map((match) => match[1]);
    expect(copied.length).toBeGreaterThan(0);
    for (const folder of copied) {
      const inFixture = paths.some((path) =>
        path.startsWith(`${NAMESPACE}${folder}/`),
      );
      expect(inFixture, `reset.sh copies ${folder}, absent from fixture`).toBe(
        true,
      );
    }
  });

  test("decision files match the dated pattern the layout requires", () => {
    const decisions = paths.filter(
      (path) => path.includes("/decisions/") && !path.endsWith("README.md"),
    );
    expect(decisions.length).toBeGreaterThan(0);
    for (const path of decisions) {
      expect(DECISION_LOG_PATTERN.test(path), `${path} is not dated`).toBe(
        true,
      );
    }
  });
});
