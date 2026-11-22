/**
 * The operator's models.json (F-7, R-1a step 2): an endpoint added there is
 * usable with no code change, the runtime stays isolated (C-3a), and a
 * broken file is a configuration error that never quotes the file.
 * No network: the custom endpoint is a closed port on the loopback address.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { parseAgentSettings } from "../pipeline/agent-settings.ts";
import { resolveEnabledModels } from "../pipeline/config.ts";
import { createModelRuntime, ModelsFileError } from "./model-runtime.ts";
import { createPiSdkAgentStep } from "./pi-sdk-step.ts";
import { noteTool } from "./testing.ts";

const work = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-models-")));
after(() => rmSync(work, { recursive: true, force: true }));
let n = 0;
function agentDir(modelsJson?: string): string {
  const dir = join(work, `agent-${n++}`);
  mkdirSync(dir);
  if (modelsJson !== undefined) writeFileSync(join(dir, "models.json"), modelsJson);
  return dir;
}

const ENDPOINT = JSON.stringify({
  providers: {
    "team-gateway": {
      baseUrl: "http://127.0.0.1:9/v1",
      api: "openai-completions",
      apiKey: "dummy-key-for-a-local-endpoint",
      models: [{ id: "reviewer-model" }],
    },
  },
});

describe("models.json from the agent directory (F-7)", () => {
  test("adds the operator's endpoint to pi's catalog; writes nothing next to it", async () => {
    const dir = agentDir(ENDPOINT);
    const runtime = await createModelRuntime({ agentDir: dir });
    const model = runtime.getModel("team-gateway", "reviewer-model");
    assert.equal(model?.baseUrl, "http://127.0.0.1:9/v1");
    assert.ok(runtime.getModels("openrouter").length > 0, "pi's own catalog stays");
    assert.deepEqual(readdirSync(dir), ["models.json"], "no models-store.json or auth.json in the operator's directory");
    assert.equal(process.env.PI_OFFLINE, "1");
  });

  test("an endpoint it adds can be enabled for the repository by pattern", async () => {
    const runtime = await createModelRuntime({ agentDir: agentDir(ENDPOINT) });
    const { models } = await resolveEnabledModels(parseAgentSettings('{"enabledModels":["team-gateway/*"]}'), runtime);
    assert.deepEqual(models, [{ provider: "team-gateway", id: "reviewer-model" }]);
  });

  test("without an agent directory, or without the file: pi's catalog only", async () => {
    for (const runtime of [await createModelRuntime(), await createModelRuntime({ agentDir: agentDir() })]) {
      assert.equal(runtime.getModel("team-gateway", "reviewer-model"), undefined);
    }
  });

  test("a broken file is an error that does not quote it", async () => {
    const secret = "sk-this-must-not-appear";
    for (const text of [`{"providers": {"x": {"apiKey": "${secret}"`, JSON.stringify({ providers: { x: { apiKey: secret, models: "no" } } })]) {
      await assert.rejects(createModelRuntime({ agentDir: agentDir(text) }), (e: Error) => {
        assert.ok(e instanceof ModelsFileError, String(e));
        assert.match(e.message, /models\.json/);
        assert.ok(!e.message.includes(secret), e.message);
        return true;
      });
    }
  });

  test("a step uses the endpoint with no code change; without the directory the provider is unknown", async () => {
    const request = {
      role: "reviewer" as const,
      model: { provider: "team-gateway", id: "reviewer-model" },
      systemPrompt: "Review.",
      prompt: "Go.",
      roots: { head: agentDir() },
      readTools: ["read" as const],
      outputTools: [noteTool],
      limits: { timeoutMs: 20_000, maxTurns: 2 },
    };
    const configured = await createPiSdkAgentStep({ agentDir: agentDir(ENDPOINT), retry: { enabled: false } }).run(request);
    assert.equal(configured.outcome, "error");
    assert.equal(configured.error?.kind, "provider", JSON.stringify(configured.error));
    assert.equal(configured.uncataloguedModel, undefined, "the id is catalogued, from models.json");
    assert.equal(configured.providerRequests[0]?.model, "reviewer-model", "the request was built for the endpoint");

    const plain = await createPiSdkAgentStep({ retry: { enabled: false } }).run(request);
    assert.equal(plain.error?.kind, "config");
    assert.match(plain.error.message, /unknown provider "team-gateway"/);

    const broken = await createPiSdkAgentStep({ agentDir: agentDir("{") }).run(request);
    assert.equal(broken.error?.kind, "config");
    assert.match(broken.error.message, /models\.json/);
  });
});
