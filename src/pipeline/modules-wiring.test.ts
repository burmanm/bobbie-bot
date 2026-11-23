/**
 * R-1a step 4b in the run (F-7, A-6): role tools from packages reach the
 * step, the installed packages are in the run record, and the tools the
 * packages provided are listed in the review summary.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { Value } from "typebox/value";
import type { AgentStep, AgentStepRequest, AgentStepResult, ModuleTool, OutputTool } from "../agent/index.ts";
import { FIXTURE_PACKAGES } from "../agent/testing.ts";
import { RunRecord } from "../core/index.ts";
import { DryRunPlatform, FixturePrReader } from "../platform/index.ts";
import { parseAgentSettings } from "./agent-settings.ts";
import { runReview } from "./run.ts";

const work = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-modules-wiring-")));
after(() => rmSync(work, { recursive: true, force: true }));
const BASIC = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "prs", "basic");

let n = 0;
function agentDir(settings: unknown): string {
  const dir = join(work, `agent-${n++}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  return dir;
}

/** A step that records its requests and reports the module tools it was asked for. */
function recordingStep(moduleTool: (name: string) => ModuleTool): { step: AgentStep; requests: Array<AgentStepRequest<OutputTool>> } {
  const requests: Array<AgentStepRequest<OutputTool>> = [];
  const step: AgentStep = {
    run: async <T extends OutputTool>(request: AgentStepRequest<T>): Promise<AgentStepResult<T>> => {
      requests.push(request as unknown as AgentStepRequest<OutputTool>);
      const moduleTools = [...(request.moduleTools ?? []), ...request.readTools.filter((t) => t === "read")].map(moduleTool);
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
          tools: [...request.readTools, ...request.outputTools.map((t) => t.name), ...(request.moduleTools ?? [])],
          moduleTools,
        },
      };
    },
  };
  return { step, requests };
}

async function review(dir: string, step: AgentStep) {
  const pr = join(work, `pr-${n++}`);
  cpSync(BASIC, pr, { recursive: true });
  const fixture = new FixturePrReader(pr);
  const platform = new DryRunPlatform(fixture);
  const result = await runReview({
    platform,
    snapshots: fixture.snapshots(),
    agentStep: step,
    inputs: { models: { reviewer: "openrouter/vendor/model" } },
    runsDir: join(work, "runs"),
    agent: { dir, settings: parseAgentSettings(readFileSync(join(dir, "settings.json"), "utf8")) },
  });
  return { result, platform };
}

const sourceOf = (name: string) => (name === "read" ? FIXTURE_PACKAGES.read : FIXTURE_PACKAGES.tool);

test("package tools named by a role reach the step; packages, versions and replacements are recorded and summarised", async () => {
  const dir = agentDir({
    packages: [FIXTURE_PACKAGES.tool, FIXTURE_PACKAGES.read],
    reviewBot: { roles: { reviewer: { tools: ["read", "grep", "+fixture_lookup"] } } },
  });
  const { step, requests } = recordingStep((tool) => ({ tool, source: sourceOf(tool), replaces: tool === "read" }));
  const { result, platform } = await review(dir, step);
  assert.notEqual(result.conclusion, "neutral", result.checkSummary);
  assert.deepEqual(requests[0]!.moduleTools, ["fixture_lookup"]);
  assert.deepEqual([...requests[0]!.readTools], ["read", "grep"]);

  const record = JSON.parse(readFileSync(result.recordPath!, "utf8")) as RunRecord;
  assert.deepEqual([...Value.Errors(RunRecord, record)].map((e) => e.message), []);
  assert.deepEqual(record.run.versions.packages, [
    { name: "fixture-pi-tool", source: FIXTURE_PACKAGES.tool, version: "2.1.0" },
    { name: "fixture-pi-read", source: FIXTURE_PACKAGES.read, version: "1.0.0" },
  ]);
  assert.deepEqual(record.run.versions.tools?.reviewer, ["read", "grep", "fixture_lookup"]);
  assert.deepEqual(record.run.steps[0]?.moduleTools, [
    { tool: "fixture_lookup", source: FIXTURE_PACKAGES.tool, replaces: false },
    { tool: "read", source: FIXTURE_PACKAGES.read, replaces: true },
  ]);

  const body = platform.output.review?.body ?? "";
  assert.match(body, /\*\*Extra tools from packages:\*\*/);
  assert.ok(body.includes(`- \`fixture_lookup\` from \`${FIXTURE_PACKAGES.tool}\`\n`), body);
  assert.ok(body.includes(`- \`read\` from \`${FIXTURE_PACKAGES.read}\`, replacing the bot's own`), body);
});

test("no packages, no extra tools in the summary or the record", async () => {
  const dir = agentDir({});
  const { step } = recordingStep((tool) => ({ tool, source: "x", replaces: false }));
  const harmless: AgentStep = { run: async (r) => ({ ...(await step.run(r)), harness: { name: "pi-sdk", version: "test", extensions: [], tools: [] } }) };
  const { result, platform } = await review(dir, harmless);
  const record = JSON.parse(readFileSync(result.recordPath!, "utf8")) as RunRecord;
  assert.equal(record.run.versions.packages, undefined);
  assert.equal(record.run.steps[0]?.moduleTools, undefined);
  assert.ok(!(platform.output.review?.body ?? "").includes("Extra tools"));
});

for (const [name, settings, pattern] of [
  ["a tool name without any package", { reviewBot: { roles: { reviewer: { tools: ["+fixture_lookup"] } } } }, /names fixture_lookup, but no packages are listed/],
  ["codemode, with packages (R-1a step 5b)", { packages: [FIXTURE_PACKAGES.tool], reviewBot: { roles: { reviewer: { tools: ["+codemode"] } } } }, /codemode, which this version does not provide yet/],
  ["a package that is not installed", { packages: ["npm:fixture-pi-missing@1.0.0"] }, /not installed .*review-bot setup/],
] as const) {
  test(`configuration error before any step: ${name}`, async () => {
    const { step, requests } = recordingStep((tool) => ({ tool, source: "x", replaces: false }));
    const { result } = await review(agentDir(settings), step);
    assert.equal(result.conclusion, "neutral");
    assert.match(result.checkSummary, pattern);
    assert.equal(requests.length, 0);
  });
}
