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
import type { OutputTool, ReadToolName } from "../../pi-review/extension/index.ts";

export type { OutputTool, ReadToolName };

export type Role = "reviewer" | "verifier" | "learner";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface ModelRef {
  /** pi provider id, e.g. "openrouter". */
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

/** Absolute, read-only directories. `head` is the session's working directory. */
export interface ReadRoots {
  head: string;
  base?: string;
  modcache?: string;
}

export interface StepLimits {
  /** Whole step, wall clock. */
  timeoutMs: number;
  /** No session event for this long. */
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
  limits: StepLimits;
  /** Run cancellation (for example a newer push). */
  signal?: AbortSignal;
  /** Heartbeat (C-8): after each model call and each tool call. */
  onProgress?: (progress: StepProgress) => void;
}

/** One validated output, tagged with the tool that produced it. */
export type ToolOutput<T extends OutputTool> =
  T extends OutputTool<infer Name, infer Schema extends TSchema> ? { tool: Name; value: Static<Schema> } : never;

export type StepOutcome = "ok" | "timeout" | "error" | "truncated" | "cancelled";

/** Which limit or event ended the step early. */
export type StoppedBy = "turns" | "cost" | "timeout" | "idle" | "output-length" | "cancelled";

export interface RejectedCall {
  toolCallId: string;
  tool: string;
  /**
   * - guard: blocked by the tool_call guard (allowlist, path outside the roots)
   * - not-allowed: a tool that is not declared to the model at all
   * - schema: arguments failed the output tool's schema
   * - validator: arguments failed the output tool's cross-field rules
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
  /** False when any call's cost is a catalog estimate rather than the provider's billed amount. */
  costIsBilled: boolean;
  /**
   * False when a model call was aborted in flight: aborted calls report zero
   * usage, so the figures above under-report (A-6, Q-16). Not estimated.
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
  /** All tool calls, and those that ended in an error (rejected or failed). */
  toolCalls: { total: number; failed: number };
  usage: StepUsage;
  /** `responseModel ?? model` per call, distinct, in first-seen order (A-6, C-6). */
  servedModels: string[];
  harness: {
    name: "pi-sdk";
    version: string;
    /** Extensions loaded into the session; only ours (C-3a). */
    extensions: string[];
    /** Tools declared to the model. */
    tools: string[];
  };
}

export interface AgentStep {
  run<T extends OutputTool>(request: AgentStepRequest<T>): Promise<AgentStepResult<T>>;
}
