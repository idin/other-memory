import OAuthProvider from "@cloudflare/workers-oauth-provider";

import { GitHubHandler } from "./github_handler";
import { MemoryMCP } from "./index";

/**
 * A ready-to-deploy memory server.
 *
 * This is the whole thing assembled: the MCP agent, GitHub as the identity
 * provider, and the OAuth endpoints wired together. A deployment that wants
 * the server as it comes can point `wrangler.jsonc` at this file and be done.
 *
 * It is deliberately separate from `index.ts`. That file is the library —
 * importing it must not also hand you a running worker, because a deployment
 * that needs to change anything would then have no way to do so except by
 * editing the library's own source. That is exactly what happened before this
 * split existed, and the edits were silently lost every time the library was
 * updated.
 *
 * To extend the server rather than replace it, subclass `MemoryMCP` and pass
 * the subclass to `buildWorker` instead — see the README.
 */
export default buildWorker(MemoryMCP);

/**
 * Assemble a worker around a `MemoryMCP` class.
 *
 * The class, not an instance: `serveSSE`/`serve` are static, since a Durable
 * Object is instantiated per session by the runtime rather than by this
 * code. Passing a subclass here is what lets a deployment add its own tools
 * or storage without hand-writing this OAuth wiring again — every
 * deployment's provider differs only in which class it points at.
 *
 * @param memoryMcp - `MemoryMCP` or a subclass of it.
 * @returns A worker ready to be a `wrangler.jsonc` `main`.
 */
export function buildWorker(memoryMcp: typeof MemoryMCP) {
  return new OAuthProvider({
    apiHandlers: {
      "/sse": memoryMcp.serveSSE("/sse"),
      "/mcp": memoryMcp.serve("/mcp"),
    },
    defaultHandler: GitHubHandler as never,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
  });
}
