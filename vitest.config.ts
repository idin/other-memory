import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Three kinds of test, which need three different environments.
 *
 * `worker` holds the logic tests. They run inside workerd rather than Node, so
 * `crypto.subtle` and the other Workers globals behave exactly as they do in
 * production. Nothing here touches the network.
 *
 * `repository` holds tests that inspect the repository itself rather than the
 * code — that secrets cannot be committed, that the ignore rules exist. These
 * need `node:child_process` to ask git questions, which workerd has no way to
 * provide.
 *
 * `integration` holds tests that talk to a real GitHub repository. They are
 * excluded from the default run because they are slow, need a token, and
 * mutate a repository. Run them deliberately with `npm run test:integration`.
 */
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
          }),
        ],
        test: {
          name: "worker",
          include: ["tests/**/*.test.ts"],
          // `.source.test.ts` reads files from disk, which workerd cannot
          // do. Routed by suffix rather than by filename so a new one lands
          // in the right project without editing two lists.
          exclude: [
            "tests/**/*.integration.test.ts",
            "tests/**/*.source.test.ts",
            "tests/secret_hygiene.test.ts",
          ],
        },
      },
      {
        test: {
          name: "repository",
          environment: "node",
          include: ["tests/secret_hygiene.test.ts", "tests/**/*.source.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.integration.test.ts"],
          // Each test resets the sandbox by force-pushing to GitHub and then
          // makes several API calls, so these are slow in a way no amount of
          // tuning will fix.
          testTimeout: 120_000,
          hookTimeout: 120_000,
          // They mutate one shared repository. Running them at the same time
          // would make each one part of the others' setup.
          fileParallelism: false,
          sequence: { concurrent: false },
        },
      },
    ],
  },
});
