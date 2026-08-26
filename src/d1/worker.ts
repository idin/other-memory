/**
 * A ready-to-deploy memory server with D1 storage and Workers AI embedding,
 * wired in whenever the bindings exist.
 *
 * For a deployment with a `D1Database` and an `Ai` binding: point
 * `wrangler.jsonc` at this file (or a one-line re-export of it, if the
 * binding names differ from `OTHER_MEMORY_DATABASE`/`AI`) and there is
 * nothing else to write. See `../worker.ts` for the version with neither.
 */

import { buildWorker } from "../worker";
import { D1MemoryMCP } from "./memory_mcp";

export default buildWorker(D1MemoryMCP);
