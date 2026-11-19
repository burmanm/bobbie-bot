/**
 * Time limits of the SDK step (S-4 Limits, S-9, A-6): the step timeout, the
 * inactivity timeout and the run deadline must abort a model call or a tool
 * call that is in flight, not just stop waiting for it. Also the query tools
 * (S-4 history and issue search) as the extension serves them. Run against
 * pi's scripted ("faux") model: no network, no key (AGENTS.md).
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fauxAssistantMessage, type FauxResponseStep, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { capText, type QueryTool, runBounded, scrubSecrets } from "../../pi-review/extension/index.ts";
import { RUN_DEADLINE } from "./limits.ts";
import { createPiSdkAgentStep } from "./pi-sdk-step.ts";
import { noteTool, toolResultsIn } from "./testing.ts";
import type { AgentStepRequest } from "./types.ts";

let head: string;
before(() => {
  head = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-timeouts-")));
  writeFileSync(join(head, "main.go"), "package main\n");
});
after(() => rmSync(head, { recursive: true, force: true }));

function setup(responses: FauxResponseStep[], abortGraceMs = 2_000) {
  const faux = fauxProvider();
  faux.setResponses(responses);
  const model = faux.getModel();
  const step = createPiSdkAgentStep({ providers: [faux.provider], retry: { enabled: false }, abortGraceMs });
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
  return { faux, step, request };
}

/** A provider that holds the request open until it is aborted, and records that it was. */
function heldOpen() {
  const seen: { signal?: AbortSignal; abortedAt?: number } = {};
  const response: FauxResponseStep = async (_context, options) => {
    if (options?.signal !== undefined) seen.signal = options.signal;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 30_000);
      options?.signal?.addEventListener(
        "abort",
        () => {
          seen.abortedAt = performance.now();
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
    return fauxAssistantMessage(fauxText("late"));
  };
  return { seen, response };
}

/** A provider that never answers and ignores the abort (a dead connection without a socket timeout). */
const neverResponds: FauxResponseStep = () => new Promise(() => {});

const callTool = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });

describe("an in-flight model call is aborted, not ignored (S-4 Limits, A-6)", () => {
  test("step timeout: the provider's request signal is aborted; usage incomplete", async () => {
    const held = heldOpen();
    const { step, request } = setup([held.response]);
    const started = performance.now();
    const result = await step.run(request({ limits: { timeoutMs: 300, maxTurns: 5 } }));
    assert.equal(result.outcome, "timeout");
    assert.equal(result.stoppedBy, "timeout");
    assert.equal(result.usage.usageComplete, false);
    assert.equal(held.seen.signal?.aborted, true, "the abort reached the provider request");
    assert.ok(held.seen.abortedAt! - started < 2_000);
    assert.equal(result.abandoned, undefined);
  });

  test("inactivity timeout: a provider that stops streaming is aborted", async () => {
    const held = heldOpen();
    const { step, request } = setup([callTool("ls", {}), held.response]);
    const result = await step.run(request({ limits: { timeoutMs: 20_000, idleTimeoutMs: 300, maxTurns: 5 } }));
    assert.equal(result.outcome, "timeout");
    assert.equal(result.stoppedBy, "idle");
    assert.equal(held.seen.signal?.aborted, true);
    assert.equal(result.usage.usageComplete, false);
  });

  test("run deadline: the run signal aborted with RUN_DEADLINE stops the step as a timeout, not a cancellation", async () => {
    const held = heldOpen();
    const { step, request } = setup([held.response]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(RUN_DEADLINE), 200);
    const result = await step.run(request({ signal: controller.signal }));
    assert.equal(result.outcome, "timeout");
    assert.equal(result.stoppedBy, "deadline");
    assert.equal(result.usage.usageComplete, false);
    assert.equal(held.seen.signal?.aborted, true);
  });

  test("run deadline already passed: nothing runs", async () => {
    const { faux, step, request } = setup([fauxAssistantMessage(fauxText("DONE"))]);
    const controller = new AbortController();
    controller.abort(RUN_DEADLINE);
    const result = await step.run(request({ signal: controller.signal }));
    assert.equal(result.outcome, "timeout");
    assert.equal(result.stoppedBy, "deadline");
    assert.equal(faux.state.callCount, 0);
  });

  test("outputs reported before the timeout are kept", async () => {
    const held = heldOpen();
    const { step, request } = setup([callTool("report_note", { title: "early", severity: "high", line: 1 }), held.response]);
    const result = await step.run(request({ limits: { timeoutMs: 500, maxTurns: 5 } }));
    assert.equal(result.outcome, "timeout");
    assert.deepEqual(
      result.outputs.map((o) => o.value.title),
      ["early"],
    );
  });

  test("a provider that never responds and ignores the abort: the step returns after the grace period, marked abandoned", async () => {
    const { step, request } = setup([neverResponds], 300);
    const started = performance.now();
    const result = await step.run(request({ limits: { timeoutMs: 300, maxTurns: 5 } }));
    const took = performance.now() - started;
    assert.equal(result.outcome, "timeout");
    assert.equal(result.stoppedBy, "timeout");
    assert.equal(result.abandoned, true);
    assert.equal(result.usage.usageComplete, false);
    assert.match(result.error?.message ?? "", /did not settle/);
    assert.ok(took < 3_000, `returned in ${Math.round(took)} ms`);
  });
});

/** A query tool for tests; `answer` decides what a call does. */
function queryTool(answer: (args: { q: string }, signal: AbortSignal) => Promise<string>, over: Partial<QueryTool> = {}): QueryTool {
  return {
    name: "lookup",
    description: "Look something up.",
    parameters: Type.Object({ q: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    validate: (v: { q: string }) => (v.q.includes("..") ? "no dots" : undefined),
    run: answer as QueryTool["run"],
    ...over,
  };
}

describe("hung tool calls (S-4 Limits)", () => {
  test("a query tool that never returns and ignores its signal: the inactivity timeout ends the step promptly", async () => {
    let started = 0;
    const tool = queryTool(() => {
      started++;
      return new Promise(() => {});
    });
    const { step, request } = setup([callTool("lookup", { q: "x" }), fauxAssistantMessage(fauxText("never reached"))]);
    const t = performance.now();
    const result = await step.run(
      request({ queryTools: [tool], limits: { timeoutMs: 20_000, idleTimeoutMs: 300, maxTurns: 5 } }),
    );
    assert.equal(started, 1);
    assert.equal(result.outcome, "timeout");
    assert.equal(result.stoppedBy, "idle");
    assert.equal(result.abandoned, undefined, "the extension settles the call on abort, so pi settles too");
    assert.ok(performance.now() - t < 3_000);
  });

  test("a query tool that honours its signal sees the abort when the step times out", async () => {
    let seen: AbortSignal | undefined;
    const tool = queryTool((_a, signal) => {
      seen = signal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    const { step, request } = setup([callTool("lookup", { q: "x" })]);
    const result = await step.run(request({ queryTools: [tool], limits: { timeoutMs: 400, maxTurns: 5 } }));
    assert.equal(result.stoppedBy, "timeout");
    assert.equal(seen?.aborted, true);
  });

  test("a slow query hits its own per-call timeout; the model gets an error and continues", async () => {
    const tool = queryTool(() => new Promise(() => {}), { timeoutMs: 200 });
    const { faux, step, request } = setup([callTool("lookup", { q: "x" }), fauxAssistantMessage(fauxText("DONE"))]);
    let context: unknown;
    faux.setResponses([
      callTool("lookup", { q: "x" }),
      (ctx) => {
        context = ctx;
        return fauxAssistantMessage(fauxText("DONE"));
      },
    ]);
    const result = await step.run(request({ queryTools: [tool] }));
    assert.equal(result.outcome, "ok");
    const seen = toolResultsIn(context);
    assert.equal(seen[0]?.isError, true);
    assert.match(seen[0]!.text, /lookup timed out/);
    assert.deepEqual(result.toolCalls, { total: 1, failed: 1 });
    assert.deepEqual(result.rejectedCalls, [], "an operational failure is not a rejected call");
  });
});

describe("query tools (S-4, C-3)", () => {
  test("answers are size-limited, validated, and scrubbed of token-like strings; the tool is declared", async () => {
    const big = "line\n".repeat(20_000);
    const tool = queryTool(async (a) => (a.q === "big" ? big : `token ghp_${"a".repeat(36)} here`), { maxBytes: 1_000 });
    const { faux, step, request } = setup([]);
    let context: unknown;
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("lookup", { q: "big" }, { id: "big" }), fauxToolCall("lookup", { q: "tok" }, { id: "tok" }), fauxToolCall("lookup", { q: "a/../b" }, { id: "dots" }), fauxToolCall("lookup", { nope: 1 }, { id: "schema" })],
        { stopReason: "toolUse" },
      ),
      (ctx) => {
        context = ctx;
        return fauxAssistantMessage(fauxText("DONE"));
      },
    ]);
    const result = await step.run(request({ queryTools: [tool] }));
    assert.equal(result.outcome, "ok");
    assert.ok(result.harness.tools.includes("lookup"));
    const byId = new Map(toolResultsIn(context).map((r) => [r.toolCallId, r]));
    assert.ok(Buffer.byteLength(byId.get("big")!.text) < 1_200);
    assert.match(byId.get("big")!.text, /\[truncated: \d+ more bytes not shown; narrow the query\]$/);
    assert.equal(byId.get("tok")!.text, "token [redacted] here");
    assert.equal(byId.get("dots")!.isError, true);
    assert.match(byId.get("dots")!.text, /no dots/);
    assert.equal(byId.get("schema")!.isError, true);
    assert.deepEqual(
      result.rejectedCalls.map((r) => [r.toolCallId, r.kind]),
      [["schema", "schema"]],
    );
  });

  test("a query tool name that clashes with another tool is a configuration error", async () => {
    const { step, request } = setup([]);
    const result = await step.run(request({ queryTools: [queryTool(async () => "", { name: "read" })] }));
    assert.equal(result.outcome, "error");
    assert.equal(result.error?.kind, "config");
  });

  test("helpers: capText keeps whole characters; runBounded settles on abort; scrubSecrets", async () => {
    const capped = capText("é".repeat(10), 5);
    assert.ok(!capped.text.includes("�"));
    assert.ok(capped.truncated);
    const c = new AbortController();
    setTimeout(() => c.abort(), 50);
    await assert.rejects(runBounded(() => new Promise(() => {}), c.signal, 10_000, "q"), /q aborted/);
    assert.equal(scrubSecrets("github_pat_" + "x".repeat(30)), "[redacted]");
  });
});
