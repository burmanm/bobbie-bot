/**
 * The SDK step's limits, outcomes and output handling, run against pi's
 * scripted ("faux") model: no network, no key (AGENTS.md).
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  fauxAssistantMessage,
  type FauxResponseStep,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { createPiSdkAgentStep } from "./pi-sdk-step.ts";
import { noteTool, toolResultsIn } from "./testing.ts";
import type { AgentStepRequest, StepProgress } from "./types.ts";

let head: string;

before(() => {
  head = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-step-")));
  writeFileSync(join(head, "main.go"), "package main\n");
});
after(() => rmSync(head, { recursive: true, force: true }));

function setup(responses: FauxResponseStep[]) {
  const faux = fauxProvider();
  faux.setResponses(responses);
  const model = faux.getModel();
  const step = createPiSdkAgentStep({ providers: [faux.provider], retry: { enabled: false }, abortGraceMs: 2_000 });
  const request = (over: Partial<AgentStepRequest<typeof noteTool>> = {}): AgentStepRequest<typeof noteTool> => ({
    role: "reviewer",
    model: { provider: model.provider, id: model.id },
    systemPrompt: "Review.",
    prompt: "Go.",
    roots: { head },
    readTools: ["read", "ls"],
    outputTools: [noteTool],
    limits: { timeoutMs: 20_000, maxTurns: 10 },
    ...over,
  });
  return { faux, model, step, request };
}

const loop = (n: number) => Array.from({ length: n }, () => fauxAssistantMessage([fauxToolCall("ls", {})], { stopReason: "toolUse" }));

/** A response that waits until the request is aborted (or `ms` passes). */
const hang = (ms = 15_000): FauxResponseStep => async (_context, options) => {
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    options?.signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
  return fauxAssistantMessage(fauxText("late"));
};

describe("outputs and schema violations (D-4, spike §6)", () => {
  test("valid outputs are returned typed and in order; violations are recorded and the model continues", async () => {
    let seenAfterViolations: ReturnType<typeof toolResultsIn> = [];
    const { faux, step, request } = setup([
      fauxAssistantMessage(
        [
          fauxToolCall("report_note", { title: "first", severity: "high", line: 3 }, { id: "ok-1" }),
          fauxToolCall("report_note", { title: "bad enum", severity: "critical", line: 1 }, { id: "schema-1" }),
          fauxToolCall("report_note", { severity: "low" }, { id: "schema-2" }),
          fauxToolCall("report_note", { title: "backwards", severity: "low", line: 9, endLine: 2 }, { id: "rule-1" }),
        ],
        { stopReason: "toolUse" },
      ),
      (context) => {
        seenAfterViolations = toolResultsIn(context);
        // Numeric strings are coerced by pi before validation.
        return fauxAssistantMessage([fauxToolCall("report_note", { title: "second", severity: "low", line: "7" } as never, { id: "ok-2" })], {
          stopReason: "toolUse",
        });
      },
      fauxAssistantMessage(fauxText("DONE")),
    ]);
    const result = await step.run(request());
    assert.equal(result.outcome, "ok", JSON.stringify(result.error));
    assert.deepEqual(result.outputs, [
      { tool: "report_note", value: { title: "first", severity: "high", line: 3 } },
      { tool: "report_note", value: { title: "second", severity: "low", line: 7 } },
    ]);
    // Typed: value is the schema's static type.
    const line: number = result.outputs[0]!.value.line;
    assert.equal(line, 3);
    assert.deepEqual(
      result.rejectedCalls.map((r) => [r.toolCallId, r.kind]),
      [
        ["schema-1", "schema"],
        ["schema-2", "schema"],
        ["rule-1", "validator"],
      ],
    );
    assert.match(result.rejectedCalls[2]!.reason, /endLine 2 is before line 9/);
    assert.ok(seenAfterViolations.find((r) => r.toolCallId === "schema-1")?.text.startsWith("Validation failed"));
    assert.equal(faux.state.callCount, 3, "the model was called again after the violations");
    assert.deepEqual(result.toolCalls, { total: 5, failed: 3 });
  });
});

describe("limits (F-3)", () => {
  test("turn cap stops a looping model", async () => {
    const { step, request } = setup(loop(20));
    const result = await step.run(request({ limits: { timeoutMs: 20_000, maxTurns: 3 } }));
    assert.equal(result.outcome, "truncated");
    assert.equal(result.stoppedBy, "turns");
    assert.equal(result.usage.turns, 3);
    assert.equal(result.usage.usageComplete, true, "stopped between calls, nothing in flight");
  });

  test("a model that finishes on the last allowed turn is not truncated", async () => {
    const { step, request } = setup([...loop(2), fauxAssistantMessage(fauxText("DONE"))]);
    const result = await step.run(request({ limits: { timeoutMs: 20_000, maxTurns: 3 } }));
    assert.equal(result.outcome, "ok");
    assert.equal(result.usage.turns, 3);
  });

  test("step timeout aborts a call in flight; usage is marked incomplete (A-6, Q-16)", async () => {
    const { step, request } = setup([hang()]);
    const started = performance.now();
    const result = await step.run(request({ limits: { timeoutMs: 300, maxTurns: 5 } }));
    assert.equal(result.outcome, "timeout");
    assert.equal(result.stoppedBy, "timeout");
    assert.equal(result.usage.usageComplete, false);
    assert.ok(performance.now() - started < 3_000);
  });

  test("inactivity timeout", async () => {
    const { step, request } = setup([fauxAssistantMessage([fauxToolCall("ls", {})], { stopReason: "toolUse" }), hang()]);
    const result = await step.run(request({ limits: { timeoutMs: 20_000, idleTimeoutMs: 300, maxTurns: 5 } }));
    assert.equal(result.outcome, "timeout");
    assert.equal(result.stoppedBy, "idle");
    assert.equal(result.usage.turns, 2);
  });

  test("cancellation through the signal", async () => {
    const { step, request } = setup([hang()]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const result = await step.run(request({ signal: controller.signal }));
    assert.equal(result.outcome, "cancelled");
    assert.equal(result.stoppedBy, "cancelled");
    assert.equal(result.usage.usageComplete, false);
  });

  test("an already-cancelled signal runs nothing", async () => {
    const { faux, step, request } = setup([fauxAssistantMessage(fauxText("DONE"))]);
    const controller = new AbortController();
    controller.abort();
    const result = await step.run(request({ signal: controller.signal }));
    assert.equal(result.outcome, "cancelled");
    assert.equal(faux.state.callCount, 0);
  });

  test("progress heartbeat (C-8)", async () => {
    const seen: StepProgress[] = [];
    const { step, request } = setup([...loop(2), fauxAssistantMessage(fauxText("DONE"))]);
    await step.run(request({ onProgress: (p) => seen.push(p) }));
    assert.ok(seen.some((p) => p.lastTool === "ls"));
    assert.equal(seen.at(-1)?.turns, 3);
  });
});

describe("outcomes", () => {
  test("a provider error is an error outcome; model and usage are recorded", async () => {
    const { model, step, request } = setup([fauxAssistantMessage([], { stopReason: "error", errorMessage: "HTTP 401 bad key" })]);
    const result = await step.run(request());
    assert.equal(result.outcome, "error");
    assert.deepEqual(result.error, { kind: "provider", message: "HTTP 401 bad key" });
    assert.deepEqual(result.servedModels, [model.id]);
    assert.equal(result.harness.name, "pi-sdk");
    assert.equal(result.harness.version, "1.5.2");
  });

  test("the model's output limit is truncation", async () => {
    const { step, request } = setup([fauxAssistantMessage(fauxText("cut"), { stopReason: "length" })]);
    const result = await step.run(request());
    assert.equal(result.outcome, "truncated");
    assert.equal(result.stoppedBy, "output-length");
  });

  test("ok, with the faux model's usage summed", async () => {
    const { step, request } = setup([...loop(1), fauxAssistantMessage(fauxText("DONE"))]);
    const result = await step.run(request());
    assert.equal(result.outcome, "ok");
    assert.equal(result.usage.turns, 2);
    assert.ok(result.usage.output > 0);
    assert.equal(result.usage.costIsBilled, false);
  });
});

describe("several steps in one process (spike §7)", () => {
  test("parallel steps keep their own roots, outputs and guard", async () => {
    const dirs = [0, 1, 2].map((i) => {
      const d = realpathSync(mkdtempSync(join(tmpdir(), `review-bot-par-${i}-`)));
      writeFileSync(join(d, "id.txt"), `STEP-${i}\n`);
      return d;
    });
    try {
      const runs = dirs.map(async (dir, i) => {
        let seen: ReturnType<typeof toolResultsIn> = [];
        const { step, request } = setup([
          fauxAssistantMessage(
            [fauxToolCall("read", { path: "id.txt" }, { id: "own" }), fauxToolCall("read", { path: join(dirs[(i + 1) % 3]!, "id.txt") }, { id: "other" })],
            { stopReason: "toolUse" },
          ),
          (context) => {
            seen = toolResultsIn(context);
            return fauxAssistantMessage([fauxToolCall("report_note", { title: `from-${i}`, severity: "low", line: 1 })], { stopReason: "toolUse" });
          },
          fauxAssistantMessage(fauxText("DONE")),
        ]);
        const result = await step.run(request({ roots: { head: dir } }));
        return { i, result, seen };
      });
      for (const { i, result, seen } of await Promise.all(runs)) {
        assert.equal(result.outcome, "ok");
        assert.equal(seen.find((r) => r.toolCallId === "own")?.text.trim(), `STEP-${i}`);
        assert.equal(seen.find((r) => r.toolCallId === "other")?.isError, true, "read another step's root");
        assert.deepEqual(result.outputs.map((o) => o.value.title), [`from-${i}`]);
      }
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("configuration errors fail before any model call", () => {
  const configError = async (over: Partial<AgentStepRequest<typeof noteTool>>, pattern: RegExp) => {
    const { faux, step, request } = setup([fauxAssistantMessage(fauxText("DONE"))]);
    const result = await step.run(request(over));
    assert.equal(result.outcome, "error");
    assert.equal(result.error?.kind, "config", JSON.stringify(result.error));
    assert.match(result.error.message, pattern);
    assert.equal(faux.state.callCount, 0);
  };

  test("unknown model", () => configError({ model: { provider: "openrouter", id: "no/such-model" } }, /unknown model/));
  test("missing read root", () => configError({ roots: { head, base: join(head, "nope") } }, /does not exist/));
  test("routing for a provider other than OpenRouter", async () => {
    const { model } = setup([]);
    await configError({ model: { provider: model.provider, id: model.id, routing: { sort: "price" } } }, /routing/);
  });
  test("bad limits", () => configError({ limits: { timeoutMs: 1000, maxTurns: 0 } }, /maxTurns/));
  test("tool name clash", () => configError({ outputTools: [{ ...noteTool, name: "read" }] }, /duplicate tool name/));
  test("tool name that is a pattern", () => configError({ outputTools: [{ ...noteTool, name: "report_*" }] }, /invalid output tool name/));

  test("missing credentials for a real provider (key comes from the environment only)", async () => {
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      await configError({ model: { provider: "openrouter", id: "openai/gpt-5-nano" } }, /no credentials for provider "openrouter"/);
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    }
  });

  test("rg missing when grep or find is allowed", async () => {
    const saved = process.env.PATH;
    process.env.PATH = "";
    try {
      await configError({ readTools: ["read", "grep"] }, /ripgrep \(rg\) is not installed/);
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe("inputs root (S-0, S-3)", () => {
  test("files under the inputs root are readable; the root is named in the system prompt", async () => {
    const inputs = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-inputs-")));
    writeFileSync(join(inputs, "context.md"), "INPUTS-MARKER-3301\n");
    let seen: ReturnType<typeof toolResultsIn> = [];
    let system = "";
    try {
      const { step, request } = setup([
        (context) => {
          system = JSON.stringify(context.messages);
          return fauxAssistantMessage([fauxToolCall("read", { path: join(inputs, "context.md") }, { id: "r1" })], { stopReason: "toolUse" });
        },
        (context) => {
          seen = toolResultsIn(context);
          return fauxAssistantMessage(fauxText("DONE"));
        },
      ]);
      const result = await step.run(request({ roots: { head, inputs } }));
      assert.equal(result.outcome, "ok", JSON.stringify(result.error));
      assert.equal(seen.find((r) => r.toolCallId === "r1")?.isError, false);
      assert.match(seen.find((r) => r.toolCallId === "r1")?.text ?? "", /INPUTS-MARKER-3301/);
      assert.match(system, new RegExp(`inputs: ${inputs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    } finally {
      rmSync(inputs, { recursive: true, force: true });
    }
  });
});
