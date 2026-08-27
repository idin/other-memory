import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The version a server reports must be the version it is.
 *
 * `McpServer` was constructed with a literal `"0.4.0"` and stayed there
 * through every release up to 2.5.0. Nothing failed, because nothing reads it
 * — which is precisely why it drifted: a hand-maintained copy of a value that
 * lives somewhere else has no feedback when it goes wrong.
 *
 * Asserted against the source rather than the running server because the
 * failure is invisible at runtime by construction.
 */
describe("the server reports the package's version", () => {
  const source = readFileSync(
    join(import.meta.dirname, "..", "src", "index.ts"),
    "utf8",
  );

  test("the version is not a literal", () => {
    // The exact shape that drifted: a quoted semver in the constructor.
    const constructorCall = source.slice(
      source.indexOf("new McpServer({"),
      source.indexOf("new McpServer({") + 400,
    );
    expect(constructorCall).not.toMatch(/version:\s*"\d+\.\d+\.\d+"/);
  });

  test("the version is read from the package", () => {
    expect(source).toContain('from "../package.json"');
    expect(source).toContain("version: PACKAGE_VERSION");
  });
});
