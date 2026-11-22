/**
 * F-7 question 4, on pi 1.5.2: what `PI_OFFLINE=1` does to OpenRouter's
 * per-key model list and how `models.json` merges with the catalog. `fetch`
 * is a stub and the credential is a placeholder, not a key.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { tempDir, write } from "./testing.ts";

const work = tempDir();
const saved = { env: { ...process.env }, fetch: globalThis.fetch };
let requested: string[] = [];
let allowed: string[] = [];

beforeEach(() => {
  requested = [];
  allowed = [];
  for (const name of Object.keys(process.env)) {
    if (/KEY|TOKEN|SECRET|^PI_/.test(name)) delete process.env[name];
  }
  process.env.PI_OFFLINE = "1";
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push(url);
    return url.endsWith("/models/user") ? Response.json({ data: allowed.map((id) => ({ id })) }) : new Response(null, { status: 404 });
  };
});
afterEach(() => {
  globalThis.fetch = saved.fetch;
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, saved.env);
});

async function runtime(dir: string, providerConfig?: object): Promise<ModelRuntime> {
  write(join(dir, "models.json"), providerConfig === undefined ? { providers: {} } : { providers: providerConfig });
  const created = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
    modelsStorePath: join(dir, "models-store.json"),
    allowModelNetwork: true,
  });
  await created.setRuntimeApiKey("openrouter", "placeholder");
  return created;
}

const agentDir = () => mkdtempSync(join(work, "agent-"));
const ids = (r: ModelRuntime) => r.getModels("openrouter").map((m) => m.id);

test("offline, the per-key list is not fetched: the built-in catalog stands", async () => {
  const r = await runtime(agentDir());
  await r.refresh();
  assert.deepEqual(requested, []);
  assert.ok(ids(r).length > 10);
});

test("offline, models.json adds to and overrides the built-in catalog", async () => {
  const builtin = (await runtime(agentDir())).getModels("openrouter");
  const [first, second] = builtin;
  assert.ok(first && second);
  const r = await runtime(agentDir(), {
    openrouter: { models: [{ id: "fixture/custom" }], modelOverrides: { [first.id]: { contextWindow: 12_345 } } },
    "fixture-endpoint": {
      baseUrl: "https://endpoint.invalid/v1",
      api: "openai-completions",
      apiKey: "$FIXTURE_UNSET",
      models: [{ id: "served" }],
    },
  });
  assert.equal(r.getError(), undefined);
  assert.deepEqual(ids(r).sort(), [...builtin.map((m) => m.id), "fixture/custom"].sort());
  assert.equal(r.getModel("openrouter", first.id)?.contextWindow, 12_345);
  assert.equal(r.getModel("openrouter", second.id)?.contextWindow, second.contextWindow);
  // Without an `api`, pi takes the endpoint of the first OpenAI-compatible built-in.
  const like = builtin.find((m) => m.api === "openai-completions");
  assert.equal(r.getModel("openrouter", "fixture/custom")?.baseUrl, like?.baseUrl);
  assert.equal(r.getModel("fixture-endpoint", "served")?.baseUrl, "https://endpoint.invalid/v1");
  assert.deepEqual(requested, []);
});

test("offline, redefining a built-in id in models.json replaces it whole", async () => {
  const [first] = (await runtime(agentDir())).getModels("openrouter");
  assert.ok(first);
  const r = await runtime(agentDir(), { openrouter: { models: [{ id: first.id }] } });
  const replaced = r.getModel("openrouter", first.id);
  assert.deepEqual([replaced?.contextWindow, replaced?.maxTokens, replaced?.cost.input], [128_000, 16_384, 0]);
});

test("a list saved while online keeps applying offline, and models.json still adds to it", async () => {
  const dir = agentDir();
  delete process.env.PI_OFFLINE;
  const online = await runtime(dir);
  const all = ids(online);
  allowed = all.slice(0, 1);
  requested = [];
  await online.refresh({ allowNetwork: true, providers: ["openrouter"] });
  assert.ok(requested.some((url) => url.endsWith("/models/user")));
  assert.deepEqual(ids(online), allowed);

  process.env.PI_OFFLINE = "1";
  requested = [];
  const offline = await runtime(dir, { openrouter: { models: [{ id: "fixture/custom" }] } });
  assert.deepEqual(ids(offline).sort(), [...allowed, "fixture/custom"].sort());
  assert.deepEqual(requested, []);
});

test("PI_OFFLINE only sets the default: an explicit allowNetwork still fetches", async () => {
  const r = await runtime(agentDir());
  allowed = ids(r).slice(0, 1);
  await r.refresh({ allowNetwork: true, providers: ["openrouter"] });
  assert.ok(requested.some((url) => url.endsWith("/models/user")));
  assert.deepEqual(ids(r), allowed);
});

test("for the catalog, any value of PI_OFFLINE is offline, even 0", async () => {
  process.env.PI_OFFLINE = "0";
  await (await runtime(agentDir())).refresh();
  assert.deepEqual(requested, []);
});
