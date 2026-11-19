/**
 * The review extension, passed to each pi session in-process (Q-15: the
 * runner uses a factory, so configuration travels by closure and jiti is
 * not involved).
 *
 * It registers, per step:
 * - the read tools the step allows, confined to the read roots
 *   (read/ls with checked file access; grep/find replaced so ignore files
 *   cannot hide anything),
 * - the step's typed output tools,
 * - the step's query tools (history, issue search), answered by the
 *   orchestrator (S-4),
 * - the `tool_call` guard.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createToolCallGuard, type GuardRejection, type ReadToolName } from "./guard.ts";
import { type OutputTool, registerOutputTool } from "./output-tools.ts";
import { type QueryTool, registerQueryTool } from "./query-tools.ts";
import { AllowedRoots } from "./paths.ts";
import { createConfinedLsTool, createConfinedReadTool } from "./read-tools.ts";
import { createSearchFindTool, createSearchGrepTool } from "./search-tools.ts";

export { READ_TOOLS, type GuardRejection, type ReadToolName } from "./guard.ts";
export type { OutputDetails, OutputTool } from "./output-tools.ts";
export {
  capText,
  QUERY_DEFAULT_MAX_BYTES,
  QUERY_DEFAULT_TIMEOUT_MS,
  type QueryDetails,
  type QueryTool,
  runBounded,
  scrubSecrets,
} from "./query-tools.ts";
export { AllowedRoots } from "./paths.ts";
export { findExecutable, RG_MISSING } from "./search-tools.ts";

export const EXTENSION_NAME = "review-bot";

export interface ReviewExtensionOptions {
  /** Absolute read roots. The first is the session's working directory (head). */
  roots: readonly string[];
  readTools: readonly ReadToolName[];
  outputTools: readonly OutputTool[];
  /** Read-only queries answered by the orchestrator (S-4). */
  queryTools?: readonly QueryTool[];
  /** Path to `rg`; default: found on PATH. */
  rgPath?: string;
  onReject?: (rejection: GuardRejection) => void;
  /**
   * Called with each provider request body just before it is sent
   * (`before_provider_request`; real providers only). Observes; never
   * changes the request.
   */
  onProviderRequest?: (payload: unknown) => void;
}

export function createReviewExtension(options: ReviewExtensionOptions): ExtensionFactory {
  const roots = new AllowedRoots(options.roots);
  const cwd = roots.roots[0]!;
  const search = options.rgPath === undefined ? {} : { rgPath: options.rgPath };
  const queryTools = options.queryTools ?? [];
  const allowedTools = new Set<string>([
    ...options.readTools,
    ...options.outputTools.map((t) => t.name),
    ...queryTools.map((t) => t.name),
  ]);

  return (pi) => {
    // Registered under the built-in names, so they replace pi's own tools.
    for (const name of new Set(options.readTools)) {
      if (name === "read") pi.registerTool(createConfinedReadTool(cwd, roots));
      else if (name === "ls") pi.registerTool(createConfinedLsTool(cwd, roots));
      else if (name === "grep") pi.registerTool(createSearchGrepTool(cwd, roots, search));
      else if (name === "find") pi.registerTool(createSearchFindTool(cwd, roots, search));
    }
    for (const tool of options.outputTools) registerOutputTool(pi, tool);
    for (const tool of queryTools) registerQueryTool(pi, tool);

    const guard = createToolCallGuard({
      allowedTools,
      roots,
      cwd,
      ...(options.onReject === undefined ? {} : { onReject: options.onReject }),
    });
    pi.on("tool_call", (event, ctx) => guard(event, ctx));
    const onRequest = options.onProviderRequest;
    if (onRequest !== undefined) {
      pi.on("before_provider_request", (event) => {
        try {
          onRequest(event.payload);
        } catch {
          // Observation must never break a request.
        }
        return undefined;
      });
    }
  };
}
