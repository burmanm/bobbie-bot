/**
 * The `AgentStep` interface (A-2): run one model step with a role, prompt,
 * read roots, tool allowlist and limits; return typed tool outputs, rejected
 * calls, usage and an outcome. Proposed in spike-r0-findings.md
 * ("Proposed AgentStep interface"); the differences are listed in
 * src/agent/README.md.
 *
 * `run` never throws for anything the model, the provider or the request
 * does. Those are outcomes.
 */
import type { Static, TSchema } from "typebox";
import type { OutputTool, QueryTool, ReadToolName } from "../../pi-review/extension/index.ts";
import type { ProviderRequestSummary } from "./request-summary.ts";

export type { OutputTool, ProviderRequestSummary, QueryTool, ReadToolName };

export type Role = "reviewer" | "verifier" | "learner";

/** pi's levels (`--thinking`, the `--model` suffix); pi maps each to what the model supports. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelRef {
  /**
   * pi provider id, e.g. "openrouter"; or "acp" for an external agent over
   * the Agent Client Protocol, in which case `id` is the agent's name.
   */
  provider: string;
  /** Model id as the provider names it, e.g. "openai/gpt-5-nano". */
  id: string;
  /** Default "off". */
  thinkingLevel?: ThinkingLevel;
  /**
   * Provider routing preferences, passed through unchanged (C-6). Only
   * OpenRouter supports them; for any other provider they are a
   * configuration error rather than silently dropped.
   */
  routing?: Record<string, unknown>;
}

/** Absolute, read-only directories. `head` is where relative paths resolve; it is never the session's working directory (C-3a). */
export interface ReadRoots {
  head: string;
  base?: string;
  modcache?: string;
  /**
   * Run-directory inputs the orchestrator prepared for the step (S-0, S-3):
   * `context.md` and `patches/`. Readable, never citable as evidence.
   */
  inputs?: string;
}

export interface StepLimits {
  /** Whole step, wall clock. */
  timeoutMs: number;
  /**
   * No session event (model output, tool start or end) for this long: a
   * provider that stopped streaming, or a hung tool call.
   */
  idleTimeoutMs?: number;
  /** Model calls. The step stops when another call would exceed it. */
  maxTurns: number;
  /** Checked after each model call. */
  maxCostUsd?: number;
}

export interface StepProgress {
  turns: number;
  costUsd: number;
  lastTool?: string;
}

export interface AgentStepRequest<T extends OutputTool = OutputTool> {
  role: Role;
  model: ModelRef;
  /** The method. Replaces pi's default system prompt. */
  systemPrompt: string;
  prompt: string;
  roots: ReadRoots;
  readTools: readonly ReadToolName[];
  /**
   * Typed output tools (D-4). Definitions, not names: the schemas live in
   * `core` and are plugged in by the caller.
   */
  outputTools: readonly T[];
  /**
   * Read-only queries answered by the orchestrator: history and issue
   * search (S-4). Optional; a step without them has none.
   */
  queryTools?: readonly QueryTool[];
  /**
   * Tools registered by the operator's modules that the role is configured
   * with (F-7, `reviewBot.roles.<role>.tools`). A name no loaded module
   * registers is a configuration error. A module tool with the name of one
   * of the bot's tools replaces it; name that tool in `readTools` or
   * `outputTools` as usual.
   */
  moduleTools?: readonly string[];
  /**
   * pi's built-in `codemode` tool is declared to the model (F-7 Codemode,
   * `"+codemode"` in the role's tools). Every call a script makes passes the
   * same guard as the model's own; usage reported on tool results counts
   * toward `maxCostUsd`; the step's time limits stop a script that runs on.
   */
  codemode?: boolean;
  /**
   * Where the step reports tool execution events, nested ones included, for
   * the run's saved scripts (A-6 `scripts.json`). Bound to the step's name
   * by the caller.
   */
  scripts?: ScriptSink;
  limits: StepLimits;
  /**
   * Run cancellation (for example a newer push), or the run deadline when
   * aborted with `RUN_DEADLINE` as the reason (limits.ts).
   */
  signal?: AbortSignal;
  /** Heartbeat (C-8): after each model call and each tool call. */
  onProgress?: (progress: StepProgress) => void;
}

/** A tool execution start or end as pi emits it; nested calls carry their parent's call id. */
export type ToolExecutionEvent =
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown; parentToolCallId?: string }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; isError: boolean; parentToolCallId?: string };

/** A step's view of the run's saved-scripts collector (`core/saved-scripts.ts`). */
export interface ScriptSink {
  record(event: ToolExecutionEvent): void;
  /** The saved script a call was made from, given that call's `parentToolCallId`. */
  scriptIdOf(parentToolCallId: string | undefined): string | undefined;
}

/**
 * One validated output, tagged with the tool that produced it. `scriptId`
 * is set when a codemode script made the call (A-6).
 */
export type ToolOutput<T extends OutputTool> =
  T extends OutputTool<infer Name, infer Schema extends TSchema> ? { tool: Name; value: Static<Schema>; scriptId?: string } : never;

export type StepOutcome = "ok" | "timeout" | "error" | "truncated" | "cancelled";

/** Which limit or event ended the step early. */
export type StoppedBy = "turns" | "cost" | "timeout" | "idle" | "deadline" | "output-length" | "cancelled";

export interface RejectedCall {
  toolCallId: string;
  tool: string;
  /**
   * - guard: blocked by the tool_call guard (allowlist, path outside the roots)
   * - not-allowed: a tool that is not declared to the model at all
   * - schema: arguments failed the output or query tool's schema
   * - validator: arguments failed the output or query tool's cross-field rules
   */
  kind: "guard" | "not-allowed" | "schema" | "validator";
  reason: string;
}

export interface StepUsage {
  /** Model calls, including a call cut short by an abort. */
  turns: number;
  input: number;
  /** Includes reasoning. */
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  costUsd: number;
  /**
   * False when any call's cost is a catalog estimate rather than the
   * provider's billed amount. Usage reported on tool results (codemode's
   * `models.*` calls, a module's tool) counts here and in the totals above.
   */
  costIsBilled: boolean;
  /**
   * False when a model call was aborted in flight: aborted calls report zero
   * usage, so the figures above under-report (A-6, Q-16). Not estimated.
   * Also false when a tool's usage could not be read or was never reported:
   * a script's model call cut off, or a tool call still running when the
   * step ended.
   */
  usageComplete: boolean;
  wallMs: number;
}

export interface AgentStepResult<T extends OutputTool = OutputTool> {
  outcome: StepOutcome;
  stoppedBy?: StoppedBy;
  error?: { kind: "provider" | "config" | "internal"; message: string };
  /** Validated, in call order. */
  outputs: Array<ToolOutput<T>>;
  rejectedCalls: RejectedCall[];
  /** All tool calls, nested ones (from codemode scripts) included, and those that ended in an error (rejected or failed). */
  toolCalls: { total: number; failed: number };
  usage: StepUsage;
  /** `responseModel ?? model` per call, distinct, in first-seen order (A-6, C-6). */
  servedModels: string[];
  /**
   * One summary per request pi sent to the provider, in order (A-6), from
   * `before_provider_request`. Empty for providers that do not report the
   * request body (the scripted provider; ACP agents).
   */
  providerRequests: ProviderRequestSummary[];
  /**
   * True when the requested model id is not in pi's offline catalog and was
   * used as a custom id on the provider (C-6). Its context window and output
   * limit are borrowed from another model of the provider, and cost comes
   * only from what the provider bills.
   */
  uncataloguedModel?: boolean;
  /**
   * Set when a step that was stopped did not settle within the grace period
   * after the abort (pi still waiting on a provider or tool that ignores
   * the abort). The step returned anyway; usage is incomplete.
   */
  abandoned?: boolean;
  harness: {
    /** `pi-sdk`: our pi session. `acp`: an external agent over ACP; `version` is the agent's. */
    name: "pi-sdk" | "acp";
    version: string;
    /** Extensions loaded into the session: the listed packages' entry points, then ours (C-3a, F-7). */
    extensions: string[];
    /** Tools declared to the model. */
    tools: string[];
    /** The operator's packages loaded into the session, with versions (A-6, F-7). */
    packages?: Array<{ name: string; source: string; version?: string }>;
    /**
     * Declared tools implemented by a module, with the package's source.
     * `replaces` is set when the module took over one of the bot's tools (F-7).
     */
    moduleTools?: ModuleTool[];
  };
}

/** A tool a loaded package provides in a step (F-7, A-6). */
export interface ModuleTool {
  tool: string;
  /** The package's source as configured in settings.json. */
  source: string;
  /** True when the tool has the name of one of the bot's and replaces it. */
  replaces: boolean;
}

export interface AgentStep {
  run<T extends OutputTool>(request: AgentStepRequest<T>): Promise<AgentStepResult<T>>;
}
