import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Usage } from "@earendil-works/pi-ai";
import {
  type AgentSessionEvent,
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { scrubSecrets } from "../../pi-review/extension/index.ts";
import { ScriptCollector } from "../core/index.ts";
import { type AssistantCall, StepAccounting, type ToolCallEnd } from "./accounting.ts";

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

function usage(cost: number, billed?: boolean): Usage {
  return {
    input: 7,
    output: 3,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 13,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost, ...(billed === undefined ? {} : { totalFromProvider: billed }) },
  };
}

const toolEnd = (result: unknown, toolName = "lookup"): ToolCallEnd => ({ type: "tool_execution_end", toolName, result });

describe("usage on tool results (F-7 Codemode, A-6)", () => {
  test("adds tokens and cost, and is neither a turn nor the last call", () => {
    const a = new StepAccounting({ maxTurns: 10 });
    const model = call(0.5);
    a.add(model);
    a.addToolResult(toolEnd({ usage: { ...usage(0.25, true), reasoning: 2 } }));
    assert.deepEqual([a.turns, a.input, a.output, a.cacheRead, a.cacheWrite, a.reasoning, a.costUsd], [1, 17, 8, 102, 1, 2, 0.75]);
    assert.equal(a.last, model);
    assert.equal(a.billedCalls, 1);
    assert.deepEqual(a.servedModels, [model.model]);
    assert.equal(a.costIsBilled, true);
    assert.equal(a.toolUsageMissing, false);
  });

  test("tool usage reaches the spend cap, and not the turn cap", () => {
    const a = new StepAccounting({ maxTurns: 2, maxCostUsd: 0.01 });
    a.add(call(0.001));
    for (let i = 0; i < 3; i++) a.addToolResult(toolEnd({ usage: usage(0.002, true) }));
    assert.equal(a.limitAfterTurn(true), undefined);
    a.addToolResult(toolEnd({ usage: usage(0.004, true) }));
    assert.equal(a.limitAfterTurn(true), "cost");
  });

  test("tool cost not reported as billed makes the total not fully billed", () => {
    for (const billed of [false, undefined]) {
      const a = new StepAccounting({ maxTurns: 10 });
      a.add(call(0.1));
      a.addToolResult(toolEnd({ usage: usage(0.1, billed) }));
      a.addToolResult(toolEnd({ usage: usage(0.1, true) }));
      a.add(call(0.1));
      assert.equal(a.costIsBilled, false, `totalFromProvider ${billed}`);
      assert.equal(a.toolUsageMissing, false, "an estimate is not missing");
    }
  });

  test("billed tool usage does not stand in for a model call", () => {
    const a = new StepAccounting({ maxTurns: 10 });
    a.addToolResult(toolEnd({ usage: usage(0.1, true) }));
    assert.equal(a.costIsBilled, false);
    a.add(call(0.1, {}, false));
    assert.equal(a.costIsBilled, false);
  });

  test("a result without usage changes nothing", () => {
    const a = new StepAccounting({ maxTurns: 10 });
    a.add(call(0.1));
    for (const result of [undefined, null, "text", {}, { usage: undefined }, { usage: null }]) a.addToolResult(toolEnd(result));
    assert.deepEqual([a.costUsd, a.input, a.costIsBilled, a.toolUsageMissing], [0.1, 10, true, false]);
  });

  test("a module's bad usage cannot poison or lower the total (D-19)", () => {
    for (const total of [Number.NaN, -5, Number.POSITIVE_INFINITY, "1", undefined, null]) {
      const a = new StepAccounting({ maxTurns: 10, maxCostUsd: 0.2 });
      a.add(call(0.25));
      a.addToolResult(toolEnd({ usage: { ...usage(0, true), cost: { total, totalFromProvider: true } } }));
      assert.equal(a.costUsd, 0.25, String(total));
      assert.equal(a.limitAfterTurn(true), "cost");
      assert.equal(a.toolUsageMissing, true);
      assert.equal(a.costIsBilled, false);
    }
    for (const bad of ["lots", {}, { ...usage(1, true), input: -1 }, { ...usage(1, true), reasoning: "2" }]) {
      const a = new StepAccounting({ maxTurns: 10 });
      a.addToolResult(toolEnd({ usage: bad }));
      assert.equal(a.toolUsageMissing, true);
      assert.ok(a.input >= 0 && Number.isFinite(a.costUsd));
    }
  });

  test("models.* calls that reported no usage are marked missing", () => {
    const missing = (row: object, tool = "codemode") => {
      const a = new StepAccounting({ maxTurns: 10 });
      a.addToolResult(toolEnd({ details: { calls: [row] } }, tool));
      return a.toolUsageMissing;
    };
    assert.equal(missing({ name: "models.classify", status: "cancelled" }), true);
    assert.equal(missing({ name: "models.generateImages", status: "ok" }), true);
    assert.equal(missing({ name: "models.classify", status: "ok", cost: 0 }), false);
    assert.equal(missing({ name: "models.classify", status: "error" }), false, "like a failed chat call");
    assert.equal(missing({ name: "read", status: "cancelled" }), false, "reports through its own event");
    assert.equal(missing({ name: "models.classify", status: "cancelled" }, "lookup"), false);
  });
});

/** Real pi sessions and codemode sandbox, with a scripted model and classifier: the event shapes the above relies on. */
describe("event shapes of pi 1.5.2 codemode (F-7, A-6)", () => {
  let dir: string;
  const env = { PI_OFFLINE: process.env.PI_OFFLINE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-accounting-")));
    process.env.PI_OFFLINE = "1";
    process.env.PI_CODING_AGENT_DIR = dir;
  });
  after(() => {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const classify = (delayMs = 0) =>
    `models.classify({ provider: "faux", id: "judge" }, { state: { delayMs: ${delayMs} }, questions: { q: { type: "bool", instructions: "?", criteria: { true: "y", false: "n" } } } })`;

  async function runScript(code: string, opts: { maxCostUsd?: number; awaitEndOf?: string; abortAtEndOf?: string } = {}) {
    const faux = fauxProvider({ provider: "faux" });
    const provider = {
      ...faux.provider,
      getAllModels: () => [
        ...faux.provider.getModels(),
        {
          type: "classifier",
          id: "judge",
          name: "judge",
          provider: "faux",
          api: "typesafe-system-one",
          baseUrl: "",
          input: ["text"],
          contextWindow: 1000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      classify: async (_model: unknown, context: { state: { delayMs?: number } }) => {
        await new Promise((resolve) => setTimeout(resolve, context.state.delayMs ?? 0));
        // pi prices classifiers from the catalog: never billed.
        return { api: "typesafe-system-one", provider: "faux", model: "judge", answers: {}, usage: usage(16, false), stopReason: "stop", timestamp: 0 };
      },
    } as unknown as typeof faux.provider;

    let releasePaid = () => {};
    const released = new Promise<void>((resolve) => (releasePaid = resolve));
    const tools: ExtensionFactory = (pi) => {
      pi.registerTool({
        name: "paid",
        label: "paid",
        description: "Costs 1.",
        parameters: Type.Object({ late: Type.Optional(Type.Boolean()) }),
        async execute(_id, params) {
          if (params.late) await released;
          return { content: [{ type: "text", text: "PAID-RESULT" }], details: {}, usage: usage(1, true) };
        },
      });
      pi.registerTool({
        name: "outer",
        label: "outer",
        description: "Costs 4 and calls paid.",
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _onUpdate, ctx) {
          await ctx.executeTool("paid", {});
          return { content: [{ type: "text", text: "OUTER-RESULT" }], details: {}, usage: usage(4, true) };
        },
      });
    };

    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null });
    modelRuntime.registerNativeProvider(provider);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } }, { projectTrusted: false });
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      noExtensions: true,
      extensionFactories: [tools, createCodemodeExtension()],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "Test.",
      appendSystemPrompt: [],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      modelRuntime,
      model: faux.getModel(),
      tools: ["paid", "outer", "codemode"],
      sessionManager: SessionManager.inMemory(dir),
      settingsManager,
      resourceLoader,
    });

    const accounting = new StepAccounting({ maxTurns: 10, ...(opts.maxCostUsd === undefined ? {} : { maxCostUsd: opts.maxCostUsd }) });
    const scripts = new ScriptCollector(scrubSecrets);
    const linked = new Map<string, string | undefined>();
    let mergedCost: number | undefined;
    let awaitedEnded = () => {};
    const ended = new Promise<void>((resolve) => (awaitedEnded = resolve));
    session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "tool_execution_start" || event.type === "tool_execution_end") scripts.record("review", event);
      if (event.type === "tool_execution_end") {
        accounting.addToolResult(event);
        linked.set(event.toolCallId, scripts.scriptIdOf("review", event.parentToolCallId));
        if (event.toolCallId === opts.awaitEndOf) awaitedEnded();
        if (event.toolCallId === opts.abortAtEndOf) void session.abort();
      }
      if (event.type !== "message_end") return;
      if (event.message.role === "assistant") accounting.add(event.message);
      if (event.message.role === "toolResult") mergedCost = event.message.usage?.cost.total;
    });
    const piFinishTurn = session.agent.finishTurn;
    session.agent.finishTurn = async (turn, signal) => {
      const decision = (await piFinishTurn?.(turn, signal)) ?? undefined;
      return accounting.limitAfterTurn(turn.toolResults.length > 0) === undefined ? decision : { action: "end" };
    };

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "c" })], { stopReason: "toolUse" }),
      async () => {
        releasePaid();
        if (opts.awaitEndOf !== undefined) await ended;
        return fauxAssistantMessage("done");
      },
    ]);
    try {
      await session.prompt("Go.", { expandPromptTemplates: false });
    } finally {
      releasePaid();
      session.dispose();
    }
    return { accounting, scripts: scripts.file()!, linked, mergedCost, modelCalls: faux.state.callCount };
  }

  test("every depth and models.* are counted once", { timeout: 30_000 }, async () => {
    const run = await runScript(`await tools.outer({}); await tools.paid({}); await ${classify()};`);
    assert.equal(run.accounting.costUsd, 4 + 1 + 1 + 16);
    assert.equal(run.mergedCost, 22, "pi's merged figure is the same total, so it must not be added");
    // The scripted model itself costs nothing.
    assert.equal(run.accounting.turns, 2);
    assert.equal(run.accounting.last?.stopReason, "stop");
    assert.equal(run.accounting.costIsBilled, false);
    assert.equal(run.accounting.toolUsageMissing, false);
  });

  test("nested cost hits the spend cap before the next model call", { timeout: 30_000 }, async () => {
    const run = await runScript("await tools.paid({});", { maxCostUsd: 1 });
    assert.equal(run.modelCalls, 1);
    assert.equal(run.accounting.costUsd, 1);
  });

  test("a call the script did not await is counted, though pi's merged figure misses it", { timeout: 30_000 }, async () => {
    const run = await runScript("tools.paid({ late: true }); await tools.paid({});", { awaitEndOf: "c/1" });
    assert.equal(run.mergedCost, 1);
    assert.equal(run.accounting.costUsd, 2);
    assert.deepEqual(run.scripts.scripts[0]!.nestedCalls, [
      { tool: "paid", isError: false },
      { tool: "paid", isError: false },
    ]);
  });

  test("a classifier call the script did not await is marked missing", { timeout: 30_000 }, async () => {
    // The awaited tool call lets the classifier request start before the script ends.
    const run = await runScript(`${classify(500)}; await tools.paid({});`);
    assert.equal(run.accounting.costUsd, 1);
    assert.equal(run.accounting.toolUsageMissing, true);
    assert.equal(run.accounting.costIsBilled, false);
  });

  test("a classifier call cut off by stopping the step is marked missing", { timeout: 30_000 }, async () => {
    const run = await runScript(`const judged = ${classify(1500)}; await tools.paid({}); await judged;`, { abortAtEndOf: "c/1" });
    assert.equal(run.accounting.costUsd, 1);
    assert.equal(run.accounting.toolUsageMissing, true);
    assert.equal(run.scripts.scripts[0]!.outcome, "error");
  });

  test("the collector reads pi's events, and the saved source replays", { timeout: 30_000 }, async () => {
    const code = '// @options: {"timeout_ms": 10000}\nawait tools.outer({});\nawait tools.paid({});\nreturn "SCRIPT-OUTPUT";\n';
    const run = await runScript(code);
    assert.deepEqual(run.scripts, {
      schemaVersion: 1,
      droppedScripts: 0,
      scripts: [
        {
          id: "script-1",
          step: "review",
          toolCallId: "c",
          source: code,
          sourceTruncated: false,
          sourceRedacted: false,
          outcome: "ok",
          nestedCalls: [
            { tool: "outer", isError: false },
            { tool: "paid", isError: false },
            { tool: "paid", isError: false },
          ],
          nestedTruncated: false,
        },
      ],
    });
    assert.deepEqual([...run.linked], [["c/1/1", "script-1"], ["c/1", "script-1"], ["c/2", "script-1"], ["c", undefined]]);
    const replay = await runScript(run.scripts.scripts[0]!.source);
    assert.deepEqual(replay.scripts, run.scripts);
  });

  test("a failed script keeps its outcome and its spend", { timeout: 30_000 }, async () => {
    const run = await runScript('await tools.paid({}); throw new Error("no");');
    assert.equal(run.scripts.scripts[0]!.outcome, "error");
    assert.equal(run.accounting.costUsd, 1);
  });
});
