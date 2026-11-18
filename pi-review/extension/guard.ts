/**
 * The `tool_call` guard (F-2, C-3): every call is checked before it runs.
 *
 * - The tool must be on the step's allowlist. `tools` on the session already
 *   keeps other tools from being declared; this catches anything activated
 *   by mistake (spike-r0-findings §5).
 * - Every path argument must resolve, after following symlinks, inside the
 *   allowed roots. pi itself does not confine its read tools.
 *
 * A blocked call is returned to the model as an error result and the run
 * continues.
 */
import type { ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { AllowedRoots } from "./paths.ts";

/** pi's read tools, each with a `path` argument (required for read, optional otherwise). */
export const READ_TOOLS = ["read", "grep", "find", "ls"] as const;
export type ReadToolName = (typeof READ_TOOLS)[number];

const PATH_TOOLS: ReadonlySet<string> = new Set(READ_TOOLS);

export interface GuardRejection {
  toolCallId: string;
  tool: string;
  reason: string;
}

export interface GuardOptions {
  allowedTools: ReadonlySet<string>;
  roots: AllowedRoots;
  /** Session working directory (the head root); base for relative paths. */
  cwd: string;
  onReject?: (rejection: GuardRejection) => void;
}

export function checkToolCall(event: ToolCallEvent, cwd: string, options: GuardOptions): string | undefined {
  if (event.parentToolCallId !== undefined) {
    return `Tool "${event.toolName}" may not be called from another tool.`;
  }
  if (!options.allowedTools.has(event.toolName)) {
    return `Tool "${event.toolName}" is not on this step's allowlist.`;
  }
  if (!PATH_TOOLS.has(event.toolName)) return undefined;
  const raw = (event.input as { path?: unknown }).path;
  // grep/find/ls default to the working directory, which is the head root.
  if (raw === undefined && event.toolName !== "read") return undefined;
  const checked = options.roots.check(raw, cwd);
  return checked.ok ? undefined : checked.reason;
}

export function createToolCallGuard(options: GuardOptions) {
  return (event: ToolCallEvent, ctx: { cwd: string }): ToolCallEventResult | undefined => {
    const reason = checkToolCall(event, ctx.cwd || options.cwd, options);
    if (reason === undefined) return undefined;
    options.onReject?.({ toolCallId: event.toolCallId, tool: event.toolName, reason });
    return { block: true, reason };
  };
}
