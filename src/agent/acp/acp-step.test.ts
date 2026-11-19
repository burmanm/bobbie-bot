/**
 * The ACP step against a scripted ACP agent (fake-agent.ts) over real
 * stdio: no model, no network (AGENTS.md).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { noteTool } from "../testing.ts";
import type { AgentStepRequest } from "../types.ts";
import { createRoutedAgentStep } from "../routed-step.ts";
import { createAcpAgentStep } from "./acp-step.ts";
import { extractCalls } from "./outputs.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fake-agent.ts");
let head: string;
let work: string;

before(() => {
  head = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-acp-head-")));
  work = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-acp-")));
  writeFileSync(join(head, "main.go"), "package main\nfunc main() {}\n// end\n");
});
after(() => {
  rmSync(head, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

let logSeq = 0;
function setup(scenario: string, extra: { abortGraceMs?: number } = {}) {
  const logFile = join(work, `log-${++logSeq}.jsonl`);
  const step = createAcpAgentStep({
    agents: { fake: { command: process.execPath, args: [FAKE, scenario], env: { FAKE_ACP_LOG: logFile, FAKE_EXTRA: "yes" } } },
    abortGraceMs: extra.abortGraceMs ?? 2_000,
  });
  const request = (over: Partial<AgentStepRequest<typeof noteTool>> = {}): AgentStepRequest<typeof noteTool> => ({
    role: "reviewer",
    model: { provider: "acp", id: "fake" },
    systemPrompt: "Review.",
    prompt: "Go.",
    roots: { head },
    readTools: ["read", "ls"],
    outputTools: [noteTool],
    limits: { timeoutMs: 20_000, maxTurns: 10 },
    ...over,
  });
  const logged = (): Array<Record<string, unknown>> =>
    existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { step, request, logged };
}

describe("ACP agent step", () => {
  test("outputs are checked, rejected calls are corrected once, the client stays read-only", async () => {
    const prevToken = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "not-a-real-token";
    const { step, request, logged } = setup("outputs");
    let result;
    try {
      result = await step.run(request());
    } finally {
      if (prevToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = prevToken;
    }

    assert.equal(result.outcome, "ok", JSON.stringify(result.error));
    assert.deepEqual(
      result.outputs.map((o) => o.value.title),
      ["good", "fixed"],
    );
    assert.deepEqual(
      result.rejectedCalls.map((r) => `${r.kind}:${r.tool}`).sort(),
      ["guard:execute", "guard:fs/read_text_file", "guard:fs/write_text_file", "not-allowed:write_file", "schema:report_note"].sort(),
    );
    assert.equal(result.usage.turns, 3, "two prompt rounds and one tool call");
    assert.equal(result.usage.input, 150);
    assert.equal(result.usage.output, 30);
    assert.equal(result.usage.costUsd, 0.02);
    assert.equal(result.usage.usageComplete, true);
    assert.deepEqual(result.servedModels, ["fake-model-1"]);
    assert.equal(result.harness.name, "acp");
    assert.equal(result.harness.version, "9.9.9");

    const log = logged();
    const first = log.find((e) => e.env) as { env: Record<string, unknown>; cwd: string };
    assert.equal(first.env.GH_TOKEN, null, "GitHub tokens are withheld from the agent");
    assert.equal(first.env.FAKE_EXTRA, "yes");
    assert.equal(first.cwd, head);
    const init = log.find((e) => e.initialize)!.initialize as { clientCapabilities: unknown };
    assert.deepEqual(init.clientCapabilities, { fs: { readTextFile: true, writeTextFile: false }, terminal: false });
    assert.deepEqual(log.find((e) => e.execute)!.execute, { jsonrpc: "2.0", id: 1000, result: { outcome: { outcome: "selected", optionId: "no" } } });
    assert.deepEqual((log.find((e) => e.read)!.read as { result: unknown }).result, { outcome: { outcome: "selected", optionId: "yes" } });
    assert.deepEqual((log.find((e) => e.inside)!.inside as { result: unknown }).result, { content: "func main() {}" });
    assert.match(JSON.stringify(log.find((e) => e.outside)), /outside the allowed read roots/);
    assert.match(JSON.stringify(log.find((e) => e.write)), /-32601/);
    const prompts = log.filter((e) => e.prompt) as Array<{ text: string }>;
    assert.equal(prompts.length, 2);
    assert.match(prompts[0]!.text, /<instructions>\nReview\.\n<\/instructions>/);
    assert.match(prompts[0]!.text, /### report_note/);
    assert.match(prompts[0]!.text, new RegExp(`head: ${head}`));
    assert.match(prompts[1]!.text, /1 accepted/);
    assert.match(prompts[1]!.text, /report_note: Validation failed/);
  });

  test("a timeout cancels the session and the step ends as a timeout", async () => {
    const { step, request, logged } = setup("hang");
    const result = await step.run(request({ limits: { timeoutMs: 500, maxTurns: 10 } }));
    assert.equal(result.outcome, "timeout");
    assert.equal(result.stoppedBy, "timeout");
    assert.equal(result.error, undefined);
    assert.ok(logged().some((e) => e.cancel), "session/cancel was sent");
  });

  test("agent tool calls count as turns", async () => {
    const { step, request } = setup("loop");
    const result = await step.run(request({ limits: { timeoutMs: 10_000, maxTurns: 4 } }));
    assert.equal(result.outcome, "truncated");
    assert.equal(result.stoppedBy, "turns");
  });

  test("an agent that ignores cancel is killed after the grace period", async () => {
    const { step, request } = setup("deaf", { abortGraceMs: 300 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await step.run(request({ signal: controller.signal }));
    assert.equal(result.outcome, "cancelled");
    assert.equal(result.error?.message, "ACP agent did not settle after cancel");
  });

  test("configuration errors before any prompt", async () => {
    const { step, request } = setup("outputs");
    const unknown = await step.run(request({ model: { provider: "acp", id: "nope" } }));
    assert.equal(unknown.error?.kind, "config");
    assert.match(unknown.error!.message, /unknown ACP agent "nope" \(configured: fake\)/);
    const routing = await step.run(request({ model: { provider: "acp", id: "fake", routing: { only: ["x"] } } }));
    assert.equal(routing.error?.kind, "config");

    const missing = await createAcpAgentStep({ agents: { x: { command: join(work, "no-such-agent") } } }).run(request({ model: { provider: "acp", id: "x" } }));
    assert.equal(missing.error?.kind, "config");
    assert.match(missing.error!.message, /cannot start ACP agent/);

    const auth = await setup("auth").step.run(request());
    assert.equal(auth.error?.kind, "config");
    assert.match(auth.error!.message, /needs authentication/);

    const exited = await setup("exit").step.run(request());
    assert.equal(exited.error?.kind, "provider");
    assert.match(exited.error!.message, /exited \(code 3\)/);
  });

  test("the routed step sends acp/* to the ACP step and reports a missing one", async () => {
    const pi = { run: async () => assert.fail("pi step must not run") } as never;
    const routed = createRoutedAgentStep({ pi });
    const result = await routed.run(setup("outputs").request());
    assert.equal(result.error?.kind, "config");
    assert.match(result.error!.message, /--acp-agent/);
  });
});

describe("ACP output block", () => {
  test("the last json fence wins; plain JSON and bare lists are accepted", () => {
    assert.deepEqual(extractCalls('```json\n{"outputs":[]}\n```\ntext\n```json\n{"outputs":[{"tool":"a","arguments":{}}]}\n```'), {
      calls: [{ tool: "a", arguments: {} }],
    });
    assert.deepEqual(extractCalls('[{"name":"b","arguments":{"x":1}}]'), { calls: [{ tool: "b", arguments: { x: 1 } }] });
    assert.ok("error" in extractCalls("no json here"));
    assert.ok("error" in extractCalls('```json\n{"other": 1}\n```'));
  });
});
