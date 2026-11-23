/**
 * R-1a step 2b: the configuration reaches the run (F-7). The H-42 and H-45
 * regressions that need only inputs are in security-regressions.test.ts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { Value } from "typebox/value";
import type { AgentStep, AgentStepRequest, AgentStepResult, OutputTool } from "../agent/index.ts";
import { RunRecord } from "../core/index.ts";
import { DryRunPlatform, FixturePrReader } from "../platform/index.ts";
import { type AgentSettings, NO_AGENT_SETTINGS, parseAgentSettings } from "./agent-settings.ts";
import { type ConfigInputs, DEFAULT_LIMITS, initialRunTimeoutMs, type ModelCatalog } from "./config.ts";
import { type ReviewRunOptions, runReview } from "./run.ts";

const work = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-wiring-")));
after(() => rmSync(work, { recursive: true, force: true }));
const BASIC = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "prs", "basic");

let n = 0;
/** The basic fixture PR with the base branch's `.review/review-bot.yaml` replaced. */
function prWithYaml(yaml: string): string {
  const dir = join(work, `pr-${n++}`);
  cpSync(BASIC, dir, { recursive: true });
  writeFileSync(join(dir, "base", ".review", "review-bot.yaml"), yaml);
  return dir;
}

/** An agent directory with these files. */
function agentDir(files: Record<string, unknown>): string {
  const dir = join(work, `agent-${n++}`);
  mkdirSync(dir);
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  return dir;
}

/** A step that records what it was asked and reports nothing. */
function recordingStep(): { step: AgentStep; requests: Array<AgentStepRequest<OutputTool>> } {
  const requests: Array<AgentStepRequest<OutputTool>> = [];
  const step: AgentStep = {
    run: async <T extends OutputTool>(request: AgentStepRequest<T>): Promise<AgentStepResult<T>> => {
      requests.push(request as unknown as AgentStepRequest<OutputTool>);
      return {
        outcome: "ok",
        outputs: [],
        rejectedCalls: [],
        toolCalls: { total: 0, failed: 0 },
        usage: { turns: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, costIsBilled: true, usageComplete: true, wallMs: 1 },
        servedModels: [`${request.model.provider}/${request.model.id}`],
        providerRequests: [],
        harness: {
          name: "pi-sdk",
          version: "test",
          extensions: [],
          tools: [...request.readTools, ...request.outputTools.map((t) => t.name), ...(request.queryTools ?? []).map((t) => t.name)],
        },
      };
    },
  };
  return { step, requests };
}

const catalogOf = (...names: string[]): ModelCatalog =>
  ({ getAvailable: async () => names.map((s) => ({ provider: s.slice(0, s.indexOf("/")), id: s.slice(s.indexOf("/") + 1), name: s })) }) as unknown as ModelCatalog;

async function review(o: { dir: string; agentStep: AgentStep; inputs: ConfigInputs; agent?: ReviewRunOptions["agent"] }) {
  const fixture = new FixturePrReader(o.dir);
  const platform = new DryRunPlatform(fixture);
  const result = await runReview({
    platform,
    snapshots: fixture.snapshots(),
    agentStep: o.agentStep,
    inputs: o.inputs,
    runsDir: join(work, "runs"),
    ...(o.agent === undefined ? {} : { agent: o.agent }),
  });
  return { result, platform };
}

describe("H-42: the base branch's YAML cannot replace the model", () => {
  test("with settings: only a model in enabledModels; the operator's model otherwise stands", async () => {
    const dir = agentDir({ "settings.json": { enabledModels: ["openrouter/vendor/allowed"], reviewBot: { roles: { reviewer: { model: "openrouter/vendor/operator" } } } } });
    const agent = (settings: AgentSettings) => ({ dir, settings, models: async () => catalogOf("openrouter/vendor/operator", "openrouter/vendor/allowed", "openrouter/vendor/other") });
    const settings = parseAgentSettings(readFileSync(join(dir, "settings.json"), "utf8"));

    const refused = recordingStep();
    const r1 = await review({ dir: prWithYaml("roles: { reviewer: openrouter/vendor/other }\n"), agentStep: refused.step, inputs: {}, agent: agent(settings) });
    assert.equal(r1.result.conclusion, "neutral");
    assert.match(r1.result.checkSummary, /roles\.reviewer "openrouter\/vendor\/other" \(not in enabledModels\)/);
    assert.equal(refused.requests.length, 0);

    const allowed = recordingStep();
    const r2 = await review({ dir: prWithYaml("roles: { reviewer: openrouter/vendor/allowed }\n"), agentStep: allowed.step, inputs: {}, agent: agent(settings) });
    assert.notEqual(r2.result.conclusion, "neutral", r2.result.checkSummary);
    assert.deepEqual(allowed.requests.map((r) => `${r.model.provider}/${r.model.id}`), ["openrouter/vendor/allowed"]);
  });

  test("the YAML cannot raise a limit from settings either", async () => {
    const dir = agentDir({ "settings.json": { reviewBot: { limits: { runCostUsd: 2 } } } });
    const { result } = await review({
      dir: prWithYaml("limits: { runCostUsd: 900 }\n"),
      agentStep: recordingStep().step,
      inputs: { models: { reviewer: "openrouter/vendor/model" } },
      agent: { dir, settings: parseAgentSettings(readFileSync(join(dir, "settings.json"), "utf8")) },
    });
    assert.match(result.checkSummary, /limits\.runCostUsd 900 \(at most 2\)/);
  });
});

describe("settings reach the run (F-7, A-6)", () => {
  test("role tools, thinking level and the models.json hash are applied and recorded", async () => {
    const modelsJson = JSON.stringify({ providers: {} });
    const dir = agentDir({
      "settings.json": {
        reviewBot: {
          roles: { reviewer: { model: "openrouter/vendor/model:xhigh", tools: ["read", "grep"] }, verifier: { model: "openrouter/vendor/other:max", tools: ["-find"] } },
        },
      },
      "models.json": modelsJson,
    });
    const { step, requests } = recordingStep();
    const { result } = await review({
      dir: prWithYaml(""),
      agentStep: step,
      inputs: {},
      agent: { dir, settings: parseAgentSettings(readFileSync(join(dir, "settings.json"), "utf8")) },
    });
    assert.notEqual(result.conclusion, "neutral", result.checkSummary);
    const reviewer = requests.find((r) => r.role === "reviewer")!;
    assert.deepEqual([...reviewer.readTools], ["read", "grep"]);
    assert.equal(reviewer.queryTools, undefined);
    assert.equal(reviewer.model.thinkingLevel, "xhigh");
    assert.ok(reviewer.outputTools.length > 0, "output tools are always added");

    const record = JSON.parse(readFileSync(result.recordPath!, "utf8")) as RunRecord;
    assert.deepEqual([...Value.Errors(RunRecord, record)].map((e) => e.message), []);
    const v = record.run.versions;
    assert.equal(v.modelsJsonSha256, createHash("sha256").update(modelsJson).digest("hex"));
    assert.deepEqual(v.thinking, { reviewer: "xhigh", verifier: "max" });
    assert.deepEqual(v.tools, { reviewer: ["read", "grep"], verifier: ["read", "ls", "grep", "git_log", "git_blame", "git_show", "search_issues"] });
    assert.equal(record.run.steps[0]?.thinkingLevel, "xhigh");
    assert.ok(record.run.steps[0]?.tools?.includes("report_finding"));
  });

  test("a tool this version does not provide is a configuration error, not dropped", async () => {
    const dir = agentDir({ "settings.json": { reviewBot: { roles: { reviewer: { model: "openrouter/vendor/model", tools: ["+mytool"] } } } } });
    const { step, requests } = recordingStep();
    const { result } = await review({ dir: prWithYaml(""), agentStep: step, inputs: {}, agent: { dir, settings: parseAgentSettings(readFileSync(join(dir, "settings.json"), "utf8")) } });
    assert.equal(result.conclusion, "neutral");
    assert.match(result.checkSummary, /tools in settings\.json names mytool, but no packages are listed/);
    assert.equal(requests.length, 0);
  });

  test("codemode is pi's (R-1a step 5b): it reaches the step as the codemode flag, without packages", async () => {
    const dir = agentDir({ "settings.json": { reviewBot: { roles: { reviewer: { model: "openrouter/vendor/model", tools: ["+codemode"] } } } } });
    const { step, requests } = recordingStep();
    await review({ dir: prWithYaml(""), agentStep: step, inputs: {}, agent: { dir, settings: parseAgentSettings(readFileSync(join(dir, "settings.json"), "utf8")) } });
    assert.equal(requests[0]?.codemode, true);
    assert.equal(requests[0]?.moduleTools, undefined);
    assert.ok(requests[0]?.scripts !== undefined, "no collector for the saved scripts");
  });

  test("without an agent directory the defaults are today's read-only set and nothing is hashed", async () => {
    const { step, requests } = recordingStep();
    const { result } = await review({ dir: prWithYaml(""), agentStep: step, inputs: { models: { reviewer: "openrouter/vendor/model" } } });
    assert.deepEqual([...requests[0]!.readTools], ["read", "ls", "grep", "find"]);
    const record = JSON.parse(readFileSync(result.recordPath!, "utf8")) as RunRecord;
    assert.equal(record.run.versions.modelsJsonSha256, undefined);
    assert.deepEqual(record.run.versions.thinking, { reviewer: "off" });
  });

  test("the first run deadline: inputs, else settings, else the default; never above the ceiling", () => {
    const settings = parseAgentSettings(JSON.stringify({ reviewBot: { limits: { runTimeoutSeconds: 600 } } }));
    assert.equal(initialRunTimeoutMs({}, NO_AGENT_SETTINGS), DEFAULT_LIMITS.runTimeoutMs);
    assert.equal(initialRunTimeoutMs({}, settings), 600_000);
    assert.equal(initialRunTimeoutMs({ runTimeoutMs: 900_000 }, settings), 900_000);
    assert.equal(initialRunTimeoutMs({ runTimeoutCeilingMs: 300_000 }, settings), 300_000);
    assert.equal(initialRunTimeoutMs({ runTimeoutCeilingMs: 3_000_000 }, settings), 600_000);
  });

  test("a model the settings give, with no input: the no-model message names settings.json", async () => {
    const { result } = await review({ dir: prWithYaml(""), agentStep: recordingStep().step, inputs: {} });
    assert.match(result.checkSummary, /settings\.json/);
  });

  test("an empty settings value is frozen and shared safely", () => {
    assert.ok(Object.isFrozen(NO_AGENT_SETTINGS) && Object.isFrozen(NO_AGENT_SETTINGS.enabledModels));
  });
});
