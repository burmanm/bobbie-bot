/**
 * The `tool_call` guard (F-2, C-3): every call is checked before it runs.
 *
 * - The tool must be on the step's allowlist. `tools` on the session already
 *   keeps other tools from being declared; this catches anything activated
 *   by mistake (spike-r0-findings §5).
 * - Every path argument must resolve, after following symlinks, inside the
 *   allowed roots. pi itself does not confine its read tools. A relative
 *   path resolves in head, as in the tools, and never in the session's cwd
 *   (C-3a).
 *
 * A blocked call is returned to the model as an error result and the run
 * continues.
 *
 * A module may replace one of these tools (F-7, H-29). The checks stay on
 * the name, and the replacement is handed the checked, absolute path:
 * pi's own tools resolve relative paths against `ctx.cwd`, which is the
 * step's neutral directory, not head (C-3a, R-1a step 1).
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
  /** The first is head, the base for relative paths. */
  roots: AllowedRoots;
  onReject?: (rejection: GuardRejection) => void;
  /**
   * The path tools a module has replaced. Read at call time: the step knows
   * only once every extension has loaded.
   */
  replaced?: () => ReadonlySet<string>;
}

export type ToolCallCheck = { ok: true; path?: string } | { ok: false; reason: string };

export function checkToolCall(event: ToolCallEvent, options: GuardOptions): string | undefined {
  const checked = checkToolCallPath(event, options);
  return checked.ok ? undefined : checked.reason;
}

/** As `checkToolCall`, with the canonical path a path tool will work on (head when omitted). */
export function checkToolCallPath(event: ToolCallEvent, options: GuardOptions): ToolCallCheck {
  if (event.parentToolCallId !== undefined) {
    return { ok: false, reason: `Tool "${event.toolName}" may not be called from another tool.` };
  }
  if (!options.allowedTools.has(event.toolName)) {
    return { ok: false, reason: `Tool "${event.toolName}" is not on this step's allowlist.` };
  }
  if (!PATH_TOOLS.has(event.toolName)) return { ok: true };
  const raw = (event.input as { path?: unknown }).path;
  // Without a path, grep, find and ls work on head, which is a root.
  if (raw === undefined && event.toolName !== "read") return { ok: true, path: options.roots.head };
  const checked = options.roots.check(raw, options.roots.head);
  return checked.ok ? { ok: true, path: checked.path } : { ok: false, reason: checked.reason };
}

export function createToolCallGuard(options: GuardOptions) {
  return (event: ToolCallEvent): ToolCallEventResult | undefined => {
    const checked = checkToolCallPath(event, options);
    if (checked.ok) {
      // pi executes the input as hooks leave it, and this guard is the last
      // hook (our extension loads after every module).
      if (checked.path !== undefined && options.replaced?.().has(event.toolName)) {
        (event.input as { path?: unknown }).path = checked.path;
      }
      return undefined;
    }
    const reason = checked.reason;
    options.onReject?.({ toolCallId: event.toolCallId, tool: event.toolName, reason });
    return { block: true, reason };
  };
}
