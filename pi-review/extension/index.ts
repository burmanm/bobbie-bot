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
 * - the `tool_call` guard,
 * - the system prompt's `cwd` section.
 *
 * The session's cwd is an empty directory outside every root (C-3a, D-15),
 * so nothing here uses `ctx.cwd`: the tools and the guard resolve relative
 * and omitted paths in head.
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
  /** Absolute read roots. The first is head, where relative paths resolve; it is never the session's cwd. */
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
      if (name === "read") pi.registerTool(createConfinedReadTool(roots));
      else if (name === "ls") pi.registerTool(createConfinedLsTool(roots));
      else if (name === "grep") pi.registerTool(createSearchGrepTool(roots, search));
      else if (name === "find") pi.registerTool(createSearchFindTool(roots, search));
    }
    for (const tool of options.outputTools) registerOutputTool(pi, tool);
    for (const tool of queryTools) registerQueryTool(pi, tool);

    const guard = createToolCallGuard({
      allowedTools,
      roots,
      ...(options.onReject === undefined ? {} : { onReject: options.onReject }),
    });
    pi.on("tool_call", (event) => guard(event));
    // pi shows the model the session's cwd. That directory is no use to it
    // (empty, outside the roots, new in every step), and head is what
    // relative paths mean to it (C-3a).
    pi.on("before_agent_start", (event) => {
      event.systemPromptOptions.sections.cwd = `${roots.head} (head: read, ls, grep and find resolve relative and omitted paths here)`;
    });
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
