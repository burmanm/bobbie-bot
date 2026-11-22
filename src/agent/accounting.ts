/**
 * Usage accounting and the turn and spend caps for one step (F-3, A-6).
 * pi has no turn cap or spend cap; the step counts `message_end` events
 * and aborts the session itself. Pure, so the caps are testable without a
 * model that reports cost (pi's scripted provider always reports zero).
 *
 * Spend outside model calls arrives as `usage` on tool results (F-7
 * Codemode). In pi 1.5.2 it appears in two places, and only one is counted:
 * - `tool_execution_end`, for calls at every depth: that call's own usage.
 *   For codemode that is the sum of its `models.*` calls. Counted here.
 * - the top-level tool result message (`message_end`): the same usage with
 *   the nested calls' usage added, as far as they had finished when the
 *   message started. A call the script did not await finishes later and is
 *   missing from it. Never counted, or everything would count twice.
 */
import type { StepLimits, StoppedBy } from "./types.ts";

/** The parts of a pi assistant message that accounting reads. */
export interface AssistantCall {
  model: string;
  responseModel?: string;
  stopReason: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning?: number;
    cost: { total: number; totalFromProvider?: boolean };
  };
}

/**
 * The parts of pi's `tool_execution_end` that accounting reads. A loaded
 * module writes the result (D-19), so its shape is checked, not trusted.
 */
export interface ToolCallEnd {
  type: "tool_execution_end";
  toolName: string;
  result: unknown;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * Whether a codemode result has a `models.*` call that may have been billed
 * without reporting it: cancelled when the script ended, or answered with
 * no usage. Such a call has no event of its own, only a row in `details`.
 */
function hasUnreportedModelCall(result: unknown): boolean {
  const rows = field(field(result, "details"), "calls");
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => {
    const name = field(row, "name");
    const status = field(row, "status");
    return (
      (name === "models.classify" || name === "models.generateImages") &&
      (status === "ok" || status === "cancelled") &&
      field(row, "cost") === undefined
    );
  });
}

export class StepAccounting {
  turns = 0;
  input = 0;
  output = 0;
  cacheRead = 0;
  cacheWrite = 0;
  reasoning: number | undefined;
  costUsd = 0;
  billedCalls = 0;
  abortedCalls = 0;
  readonly servedModels: string[] = [];
  last: AssistantCall | undefined;
  /**
   * Tool spend that could not be read or was never reported: the totals
   * under-report, like an aborted model call (A-6 `usageComplete`).
   */
  toolUsageMissing = false;

  private unbilledToolResults = 0;
  private readonly limits: Pick<StepLimits, "maxTurns" | "maxCostUsd">;

  constructor(limits: Pick<StepLimits, "maxTurns" | "maxCostUsd">) {
    this.limits = limits;
  }

  /** Record one model call (`message_end` with role "assistant"). */
  add(call: AssistantCall): void {
    this.turns++;
    this.last = call;
    const u = call.usage;
    this.input += u.input;
    this.output += u.output;
    this.cacheRead += u.cacheRead;
    this.cacheWrite += u.cacheWrite;
    if (u.reasoning !== undefined) this.reasoning = (this.reasoning ?? 0) + u.reasoning;
    this.costUsd += u.cost.total;
    if (u.cost.totalFromProvider === true) this.billedCalls++;
    if (call.stopReason === "aborted") this.abortedCalls++;
    // pi sets responseModel only when the provider served a different id.
    const served = call.responseModel ?? call.model;
    if (!this.servedModels.includes(served)) this.servedModels.push(served);
  }

  /**
   * Add the usage a tool call reported for itself. Not a turn; `last` and
   * the served models are untouched. Call it for every `tool_execution_end`,
   * nested or not, and for nothing else (see the top of this file).
   */
  addToolResult(end: ToolCallEnd): void {
    if (end.toolName === "codemode" && hasUnreportedModelCall(end.result)) this.toolUsageMissing = true;
    const usage = field(end.result, "usage");
    if (usage === undefined || usage === null) return;
    // A bad number must not poison or lower the total the spend cap compares:
    // NaN never reaches a cap and a negative cost would move away from it.
    const amount = (value: unknown): number => {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
      this.toolUsageMissing = true;
      return 0;
    };
    this.input += amount(field(usage, "input"));
    this.output += amount(field(usage, "output"));
    this.cacheRead += amount(field(usage, "cacheRead"));
    this.cacheWrite += amount(field(usage, "cacheWrite"));
    const reasoning = field(usage, "reasoning");
    if (reasoning !== undefined) this.reasoning = (this.reasoning ?? 0) + amount(reasoning);
    const cost = field(usage, "cost");
    this.costUsd += amount(field(cost, "total"));
    if (field(cost, "totalFromProvider") !== true) this.unbilledToolResults++;
  }

  /** Every part of the total, tool usage included, is an amount the provider reported as billed. */
  get costIsBilled(): boolean {
    return this.turns > 0 && this.billedCalls === this.turns && this.unbilledToolResults === 0 && !this.toolUsageMissing;
  }

  /**
   * At the end of a turn: should the step stop before the next model call?
   * `continues` is whether the model asked for tools, i.e. whether another
   * call would follow. A model that has finished is never cut off.
   */
  limitAfterTurn(continues: boolean): StoppedBy | undefined {
    if (!continues) return undefined;
    if (this.turns >= this.limits.maxTurns) return "turns";
    if (this.limits.maxCostUsd !== undefined && this.costUsd >= this.limits.maxCostUsd) return "cost";
    return undefined;
  }
}
