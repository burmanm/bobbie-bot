/**
 * Usage accounting and the turn and spend caps for one step (F-3, A-6).
 * pi has no turn cap or spend cap; the step counts `message_end` events
 * and aborts the session itself. Pure, so the caps are testable without a
 * model that reports cost (pi's scripted provider always reports zero).
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

  get costIsBilled(): boolean {
    return this.turns > 0 && this.billedCalls === this.turns;
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
