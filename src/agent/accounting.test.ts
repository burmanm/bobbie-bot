import assert from "node:assert/strict";
import { test } from "node:test";
import { type AssistantCall, StepAccounting } from "./accounting.ts";

function call(cost: number, extra: Partial<AssistantCall> = {}, billed = true): AssistantCall {
  return {
    model: "openai/gpt-5-nano",
    stopReason: "toolUse",
    usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, cost: { total: cost, totalFromProvider: billed } },
    ...extra,
  };
}

test("sums usage and records served models (A-6)", () => {
  const a = new StepAccounting({ maxTurns: 10 });
  a.add(call(0.001));
  a.add(call(0.002, { responseModel: "openai/gpt-5-nano-2026-08-01" }));
  a.add(call(0.001, { usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 3, reasoning: 2, cost: { total: 0.001 } } }));
  assert.equal(a.turns, 3);
  assert.equal(a.input, 21);
  assert.equal(a.output, 12);
  assert.equal(a.cacheRead, 200);
  assert.equal(a.cacheWrite, 3);
  assert.equal(a.reasoning, 2);
  assert.ok(Math.abs(a.costUsd - 0.004) < 1e-12);
  assert.deepEqual(a.servedModels, ["openai/gpt-5-nano", "openai/gpt-5-nano-2026-08-01"]);
  assert.equal(a.costIsBilled, false, "one call's cost was an estimate");
});

test("costIsBilled needs every call billed, and at least one call", () => {
  const a = new StepAccounting({ maxTurns: 10 });
  assert.equal(a.costIsBilled, false);
  a.add(call(0.1));
  assert.equal(a.costIsBilled, true);
});

test("turn cap stops only a model that wants to continue (F-3)", () => {
  const a = new StepAccounting({ maxTurns: 2 });
  a.add(call(0));
  assert.equal(a.limitAfterTurn(true), undefined);
  a.add(call(0));
  assert.equal(a.limitAfterTurn(false), undefined, "a finished model is not cut off");
  assert.equal(a.limitAfterTurn(true), "turns");
});

test("spend cap is checked after each model call", () => {
  const a = new StepAccounting({ maxTurns: 10, maxCostUsd: 0.01 });
  a.add(call(0.006));
  assert.equal(a.limitAfterTurn(true), undefined);
  a.add(call(0.006));
  assert.equal(a.limitAfterTurn(true), "cost");
  assert.equal(a.limitAfterTurn(false), undefined);
});

test("aborted calls are counted", () => {
  const a = new StepAccounting({ maxTurns: 10 });
  a.add(call(0, { stopReason: "aborted" }));
  assert.equal(a.abortedCalls, 1);
});
