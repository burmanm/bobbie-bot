/**
 * Regression tests for H-42 and H-45 (docs/security.md), through
 * `runReview` with inputs only, as a local dry run or the action without an
 * agent directory calls it. Both passed a base branch's YAML through the
 * legacy path that ran without settings; R-1a step 2b removed it (F-7, D-19).
 * Kept to the API that existed before that step, so they can be run against
 * an older tree.
 */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import type { AgentStep, AgentStepRequest, AgentStepResult, OutputTool } from "../agent/index.ts";
import { createPiSdkAgentStep, createScriptedProvider } from "../agent/index.ts";
import { DryRunPlatform, FixturePrReader } from "../platform/index.ts";
import type { ConfigInputs } from "./config.ts";
import { runReview } from "./run.ts";

const work = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-h42-")));
after(() => rmSync(work, { recursive: true, force: true }));
const BASIC = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "prs", "basic");

let n = 0;
function prWithYaml(yaml: string): string {
  const dir = join(work, `pr-${n++}`);
  cpSync(BASIC, dir, { recursive: true });
  writeFileSync(join(dir, "base", ".review", "review-bot.yaml"), yaml);
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
        harness: { name: "pi-sdk", version: "test", extensions: [], tools: [...request.readTools, ...request.outputTools.map((t) => t.name)] },
      };
    },
  };
  return { step, requests };
}

async function review(o: { dir: string; agentStep: AgentStep; inputs: ConfigInputs }) {
  const fixture = new FixturePrReader(o.dir);
  const platform = new DryRunPlatform(fixture);
  const result = await runReview({ platform, snapshots: fixture.snapshots(), agentStep: o.agentStep, inputs: o.inputs, runsDir: join(work, "runs") });
  return { result, platform };
}

describe("H-42: the base branch's YAML cannot replace the model", () => {
  test("without an agent directory: the input model is fixed; neutral, no model call", async () => {
    const scripted = createScriptedProvider({ reviewer: [{ text: "must not be called" }], verifier: [{ text: "must not be called" }] });
    const { result, platform } = await review({
      dir: prWithYaml("roles: { reviewer: scripted/verifier }\n"),
      agentStep: createPiSdkAgentStep({ providers: [scripted.provider], retry: { enabled: false } }),
      inputs: { models: { reviewer: "scripted/reviewer" } },
    });
    assert.equal(result.conclusion, "neutral", result.checkSummary);
    assert.match(result.checkSummary, /refused: roles\.reviewer "scripted\/verifier" \(no enabledModels, so the model is fixed\)/);
    assert.match(JSON.stringify(platform.output), /Automated review could not complete/);
    assert.deepEqual(scripted.calls, []);
  });

});

describe("H-45: the operator's upstream-provider restriction survives the YAML", () => {
  const routing = { only: ["azure"], allow_fallbacks: false };
  const inputs: ConfigInputs = { models: { reviewer: "openrouter/vendor/model" }, providers: { reviewer: ["azure"] } };
  for (const yaml of ["roles: { reviewer: openrouter/vendor/model }\n", "roles: { reviewer: { model: OpenRouter/Vendor/Model } }\n"]) {
    test(`restating the model: ${yaml.trim()}`, async () => {
      const { step, requests } = recordingStep();
      const { result } = await review({ dir: prWithYaml(yaml), agentStep: step, inputs });
      assert.notEqual(result.conclusion, "neutral", result.checkSummary);
      assert.ok(requests.length > 0);
      for (const r of requests) assert.deepEqual(r.model.routing, routing);
    });
  }

  test("the fields that used to drop or replace it are configuration errors", async () => {
    const { step, requests } = recordingStep();
    const { result } = await review({ dir: prWithYaml("roles: { reviewer: { model: openrouter/vendor/model, providers: [evil] } }\n"), agentStep: step, inputs });
    assert.equal(result.conclusion, "neutral");
    assert.match(result.checkSummary, /review-bot\.yaml is invalid/);
    assert.equal(requests.length, 0);
  });
});
