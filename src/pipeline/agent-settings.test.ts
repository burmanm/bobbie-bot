/** The agent directory's settings.json and what may override it (F-7, R-1a step 2, C-3). */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createPiSdkAgentStep, createScriptedProvider } from "../agent/index.ts";
import { DryRunPlatform, FixturePrReader } from "../platform/index.ts";
import { type AgentSettings, parseAgentSettings, parseModelSpec, readAgentSettings, resolveRoleTools } from "./agent-settings.ts";
import { ConfigError, type ConfigInputs, DEFAULT_LIMITS, NO_AGENT_SETTINGS, resolveConfig, resolveEnabledModels } from "./config.ts";
import { runReview } from "./run.ts";
import { DEFAULT_SKIP } from "./skip.ts";

const work = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-settings-")));
after(() => rmSync(work, { recursive: true, force: true }));

const settingsOf = (value: unknown): AgentSettings => parseAgentSettings(JSON.stringify(value));

/** The models pi could use: what its `getAvailable` returns. */
const CATALOG = [
  "openrouter/vendor/model",
  "openrouter/vendor/model:free",
  "openrouter/vendor/other",
  "openrouter/vendor/odd:high",
  "openrouter/anthropic/claude-x",
  "openrouter/elsewhere/thing",
  "anthropic/claude-x",
  "anthropic/claude-y-20260101",
  "local/Qwen-Big",
  "local/bracketed[1m]",
  "local/bracketed1",
].map((s) => ({ provider: s.slice(0, s.indexOf("/")), id: s.slice(s.indexOf("/") + 1), name: s }));
const runtime = { getAvailable: async () => CATALOG } as unknown as Parameters<typeof resolveEnabledModels>[1];

/** resolveConfig as step 2b will call it. */
async function configure(settings: object, yaml?: string, inputs: ConfigInputs = {}) {
  const parsed = settingsOf(settings);
  const { models } = await resolveEnabledModels(parsed, runtime);
  return resolveConfig(inputs, yaml, parsed, models);
}

const OPERATOR = {
  enabledModels: ["openrouter/vendor/*"],
  reviewBot: {
    roles: { reviewer: { model: "openrouter/vendor/model:high", tools: ["+codemode"] }, verifier: { model: "anthropic/claude-x" } },
  },
};

describe("settings.json (F-7, F-3)", () => {
  test("reads reviewBot, enabledModels and packages, and tolerates pi's other keys", () => {
    const reviewBot = {
      roles: { reviewer: { model: "openrouter/vendor/model:high", tools: ["+codemode"] }, verifier: { tools: ["read"] } },
      limits: { reviewer: { timeoutSeconds: 60, idleTimeoutSeconds: 30, maxTurns: 9, maxCostUsd: 1 }, runCostUsd: 2, runTimeoutSeconds: 600, chunkPatchLines: 100 },
      skip: { draft: false, dependencies: { labels: ["deps"] } },
      ci: { require: ["build"], onFailure: "review", timeout: "90m" },
      authorization: { label: "ok-to-review", lifetime: "per-pr" },
    };
    const packages = ["npm:@org/pi-x@1.2.3", { source: "./node_modules/pi-y", extensions: ["index.ts"], autoload: false }];
    const s = settingsOf({ $schema: "x", codemode: { mode: "on" }, defaultTools: ["bash"], somethingNew: 1, reviewBot, enabledModels: ["openrouter/*"], packages });
    assert.deepEqual(s, { reviewBot, enabledModels: ["openrouter/*"], packages });
  });

  test("without the keys: no settings, and no enabledModels", () => {
    assert.deepEqual(settingsOf({}), { reviewBot: {}, enabledModels: [], packages: [] });
    assert.deepEqual(parseAgentSettings("﻿{}"), settingsOf({}), "a byte order mark, as pi accepts");
  });

  test("unknown keys inside reviewBot are errors at every level", () => {
    for (const [reviewBot, name] of [
      [{ role: {} }, "role"],
      [{ roles: { learner: {} } }, "learner"],
      [{ roles: { reviewer: { thinking: "high" } } }, "thinking"],
      [{ roles: { reviewer: { providers: ["x"] } } }, "providers"],
      [{ roles: { reviewer: { routing: {} } } }, "routing"],
      [{ limits: { runCost: 1 } }, "runCost"],
      [{ limits: { verifier: { turns: 1 } } }, "turns"],
      [{ skip: { dependencies: { files: [] } } }, "files"],
      [{ ci: { wait: true } }, "wait"],
      [{ authorization: { who: "x" } }, "who"],
    ] as const) {
      assert.throws(() => settingsOf({ reviewBot }), new RegExp(`is invalid:.*\\(${name}\\)`), name);
    }
    assert.throws(() => parseAgentSettings('{"reviewBot":{"__proto__":{"limits":{}}}}'), ConfigError);
  });

  test("wrong values are errors", () => {
    for (const value of [
      [],
      "settings",
      { reviewBot: null },
      { reviewBot: { roles: { reviewer: "openrouter/vendor/model" } } },
      { reviewBot: { roles: { reviewer: { model: "no-provider" } } } },
      { reviewBot: { roles: { reviewer: { model: "openrouter/:high" } } } },
      { reviewBot: { limits: { runCostUsd: 0 } } },
      { reviewBot: { limits: { runTimeoutSeconds: 3_000_000 } } },
      { reviewBot: { ci: { timeout: "soon" } } },
      { enabledModels: "openrouter/*" },
      { enabledModels: [" "] },
      { packages: [{ extensions: [] }] },
      ...["+", "-", "", "read,grep", "+mcp__*", "++read", "two words"].map((t) => ({ reviewBot: { roles: { reviewer: { tools: [t] } } } })),
    ]) {
      assert.throws(() => settingsOf(value), ConfigError, JSON.stringify(value));
    }
    assert.throws(() => parseAgentSettings('{"reviewBot":{"limits":{"runCostUsd":1e999}}}'), ConfigError, "not finite");
  });

  test("malformed JSON is an error, and no error quotes the file", () => {
    for (const text of ["", "{", "null", '{"enabledModels": ["x"],}', '{"reviewBot": {}} // comment', '{"httpProxy": hunter2-placeholder}']) {
      assert.throws(
        () => parseAgentSettings(text),
        (e) => e instanceof ConfigError && !e.message.includes("hunter2"),
        text,
      );
    }
    assert.throws(
      () => settingsOf({ reviewBot: { roles: { reviewer: { model: "hunter2-placeholder" } } } }),
      (e) => e instanceof ConfigError && !e.message.includes("hunter2"),
    );
  });

  test("read from the agent directory; only an absent file means no settings", () => {
    const dir = (name: string) => {
      mkdirSync(join(work, name));
      return join(work, name);
    };
    const good = dir("good");
    writeFileSync(join(good, "settings.json"), JSON.stringify(OPERATOR));
    assert.deepEqual(readAgentSettings(good), settingsOf(OPERATOR));
    assert.deepEqual(readAgentSettings(dir("models-only")), settingsOf({}));
    assert.throws(() => readAgentSettings(join(work, "no-such-dir")), /cannot read/);
    const dangling = dir("dangling");
    symlinkSync(join(work, "nowhere"), join(dangling, "settings.json"));
    assert.throws(() => readAgentSettings(dangling), /cannot read/);
    const broken = dir("broken");
    writeFileSync(join(broken, "settings.json"), "{");
    assert.throws(() => readAgentSettings(broken), /not valid JSON/);
  });

  test("the gate can load both modules and resolve settings without loading pi", () => {
    const url = (file: string) => JSON.stringify(new URL(file, import.meta.url).href);
    const program = `
      import { registerHooks } from "node:module";
      registerHooks({ resolve(specifier, context, next) {
        if (specifier.startsWith("@earendil-works/")) throw new Error("pi was loaded: " + specifier);
        return next(specifier, context);
      } });
      const { parseAgentSettings } = await import(${url("./agent-settings.ts")});
      const { resolveConfig } = await import(${url("./config.ts")});
      resolveConfig({}, "ci: { require: required }", parseAgentSettings("{}"));
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });
});

describe("model syntax (F-7)", () => {
  const cases: Array<[string, string, string?]> = [
    ["openrouter/vendor/model", "vendor/model"],
    ["openrouter/vendor/model:free", "vendor/model:free"],
    ["openrouter/vendor/model:free:high", "vendor/model:free", "high"],
    ["openrouter/vendor/model:HIGH", "vendor/model:HIGH"],
    ["openrouter/vendor/model:", "vendor/model:"],
    ["openrouter/vendor/high", "vendor/high"],
    ...["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((l): [string, string, string] => [`openrouter/vendor/model:${l}`, "vendor/model", l]),
  ];
  for (const [spec, id, level] of cases) {
    test(spec, () => assert.deepEqual(parseModelSpec(spec), { provider: "openrouter", id, ...(level === undefined ? {} : { thinkingLevel: level }) }));
  }

  test("not a model", () => {
    for (const spec of ["no-provider", "/id", "openrouter/", "openrouter/:high"]) assert.throws(() => parseModelSpec(spec), ConfigError, spec);
  });
});

describe("role tools (F-7, S-4)", () => {
  const readOnly = ["read", "ls", "grep", "find"];
  const cases: Array<[string, string[] | undefined, string[]]> = [
    ["no setting: the default", undefined, readOnly],
    ["+name adds", ["+codemode"], [...readOnly, "codemode"]],
    ["-name removes", ["-find", "-ls"], ["read", "grep"]],
    ["plain names replace", ["read", "grep"], ["read", "grep"]],
    ["plain names, then modifiers", ["+codemode", "read", "grep", "-grep"], ["read", "codemode"]],
    ["in list order", ["+x", "-x", "-y", "+y"], [...readOnly, "y"]],
    ["no duplicates", ["read", "read", "+read"], ["read"]],
    ["empty: none", [], []],
  ];
  for (const [name, entries, expected] of cases) {
    test(name, () => assert.deepEqual(resolveRoleTools(entries, readOnly), expected));
  }

  test("the same selection pi makes of defaultTools, given pi's default", () => {
    for (const [, entries] of cases) {
      if (entries === undefined) continue;
      const pi = SettingsManager.inMemory({ defaultTools: entries }).getDefaultTools();
      assert.deepEqual(resolveRoleTools(entries, ["read", "bash", "edit", "write"]), [...new Set(pi)], entries.join());
    }
  });

  test("pi's own default and the file's defaultTools are never inherited", async () => {
    const c = await configure({ defaultTools: ["bash", "write"], reviewBot: { roles: { reviewer: { tools: ["+codemode"] } } } });
    assert.deepEqual(resolveRoleTools(c.tools.reviewer, readOnly), [...readOnly, "codemode"]);
    assert.deepEqual(resolveRoleTools(c.tools.verifier, readOnly), readOnly);
    assert.deepEqual(resolveRoleTools(["+codemode"], []), ["codemode"]);
  });
});

describe("precedence (F-7, C-2)", () => {
  test("settings override the defaults", async () => {
    const c = await configure({
      reviewBot: {
        roles: OPERATOR.reviewBot.roles,
        limits: { reviewer: { timeoutSeconds: 1800, maxCostUsd: 3 }, runCostUsd: 12, runTimeoutSeconds: 3600, chunkPatchLines: 9000 },
        skip: { draft: false, labels: ["wip"] },
      },
    });
    assert.deepEqual(c.roles.reviewer, { provider: "openrouter", id: "vendor/model", thinkingLevel: "high" });
    assert.deepEqual(c.tools, { reviewer: ["+codemode"] });
    assert.deepEqual(c.limits.reviewer, { ...DEFAULT_LIMITS.reviewer, timeoutMs: 1_800_000, maxCostUsd: 3 });
    assert.deepEqual(c.limits.verifier, DEFAULT_LIMITS.verifier);
    assert.deepEqual([c.limits.runCostUsd, c.limits.runTimeoutMs, c.limits.chunkPatchLines], [12, 3_600_000, 9000]);
    assert.deepEqual(c.skip, { ...DEFAULT_SKIP, draft: false, labels: ["wip"] });
  });

  test("workflow inputs override settings, in both directions", async () => {
    const c = await configure(
      { reviewBot: { ...OPERATOR.reviewBot, limits: { runCostUsd: 2, reviewer: { maxTurns: 10, timeoutSeconds: 60 } }, skip: { draft: false, labels: ["wip"] } } },
      undefined,
      { models: { reviewer: "local/Qwen-Big" }, runCostUsd: 7, limits: { reviewer: { maxTurns: 50 } }, skipDraft: true, skip: { labels: ["hold"] } },
    );
    assert.deepEqual(c.roles.reviewer, { provider: "local", id: "Qwen-Big" }, "the suffix goes with the model it was on");
    assert.deepEqual(c.tools.reviewer, ["+codemode"], "tools stay");
    assert.equal(c.limits.runCostUsd, 7);
    assert.deepEqual([c.limits.reviewer.maxTurns, c.limits.reviewer.timeoutMs], [50, 60_000]);
    assert.deepEqual([c.skip.draft, c.skip.labels], [true, ["hold"]]);
  });

  test("thinking and providers inputs apply to a model from settings", async () => {
    const c = await configure(OPERATOR, undefined, { thinking: { reviewer: "low" }, providers: { reviewer: ["one"] } });
    assert.deepEqual(c.roles.reviewer, { provider: "openrouter", id: "vendor/model", thinkingLevel: "low", routing: { only: ["one"], allow_fallbacks: false } });
  });

  test("the YAML narrows what inputs and settings give", async () => {
    const settings = { reviewBot: { limits: { runCostUsd: 20 } } };
    assert.equal((await configure(settings, "limits: { runCostUsd: 12 }")).limits.runCostUsd, 12);
    await assert.rejects(configure(settings, "limits: { runCostUsd: 12 }", { runCostUsd: 3 }), /runCostUsd 12 \(at most 3\)/);
  });

  test("resolving changes neither the defaults nor the settings", () => {
    const settings = settingsOf({ reviewBot: { skip: { labels: ["wip"] } } });
    const c = resolveConfig({}, "limits: { verifier: { maxTurns: 2 }, runCostUsd: 1 }", settings);
    c.skip.labels.push("changed");
    assert.equal(DEFAULT_LIMITS.verifier.maxTurns, 40);
    assert.equal(DEFAULT_LIMITS.runCostUsd, 5);
    assert.deepEqual(settings.reviewBot.skip?.labels, ["wip"]);
  });
});

describe("the base branch's limits only narrow, with or without an agent directory (F-7)", () => {
  const fields: Array<[key: string, base: number]> = [
    ["reviewer.timeoutSeconds", 1200],
    ["reviewer.idleTimeoutSeconds", 180],
    ["reviewer.maxTurns", 120],
    ["verifier.timeoutSeconds", 480],
    ["verifier.idleTimeoutSeconds", 180],
    ["verifier.maxTurns", 40],
    ["runCostUsd", 5],
    ["runTimeoutSeconds", 2700],
  ];
  const yaml = (key: string, value: number) => {
    const [a, b] = key.split(".");
    return b === undefined ? `limits: { ${a}: ${value} }` : `limits: { ${a}: { ${b}: ${value} } }`;
  };
  const effective = (c: ReturnType<typeof resolveConfig>, key: string): number | undefined => {
    const [a, b] = key.split(".");
    if (b === undefined) return a === "runCostUsd" ? c.limits.runCostUsd : c.limits.runTimeoutMs / 1000;
    const step = c.limits[a as "reviewer" | "verifier"];
    return b === "maxTurns" ? step.maxTurns : (b === "timeoutSeconds" ? step.timeoutMs : step.idleTimeoutMs!) / 1000;
  };
  for (const [key, base] of fields) {
    test(key, () => {
      for (const settings of [NO_AGENT_SETTINGS, settingsOf({})]) {
        assert.equal(effective(resolveConfig({}, yaml(key, base - 1), settings), key), base - 1, "lower");
        assert.equal(effective(resolveConfig({}, yaml(key, base), settings), key), base, "equal");
        assert.throws(() => resolveConfig({}, yaml(key, base + 1), settings), new RegExp(`${key} ${base + 1} \\(at most ${base}\\)`));
      }
    });
  }

  test("maxCostUsd can be set where there is none, and then only lowered", () => {
    for (const role of ["reviewer", "verifier"] as const) {
      assert.equal(resolveConfig({}, `limits: { ${role}: { maxCostUsd: 2 } }`, NO_AGENT_SETTINGS).limits[role].maxCostUsd, 2);
      const inputs: ConfigInputs = { limits: { [role]: { maxCostUsd: 1 } } };
      assert.equal(resolveConfig(inputs, `limits: { ${role}: { maxCostUsd: 0.5 } }`, NO_AGENT_SETTINGS).limits[role].maxCostUsd, 0.5);
      assert.throws(() => resolveConfig(inputs, `limits: { ${role}: { maxCostUsd: 2 } }`, NO_AGENT_SETTINGS), new RegExp(`${role}\\.maxCostUsd 2 \\(at most 1\\)`));
    }
  });

  test("chunkPatchLines is fixed: neither direction narrows", () => {
    assert.equal(resolveConfig({}, "limits: { chunkPatchLines: 4000 }", NO_AGENT_SETTINGS).limits.chunkPatchLines, 4000);
    for (const value of [1, 3999, 4001]) assert.throws(() => resolveConfig({}, `limits: { chunkPatchLines: ${value} }`, NO_AGENT_SETTINGS), /chunkPatchLines \d+ \(fixed at 4000\)/);
    assert.equal(resolveConfig({ chunkPatchLines: 800 }, "limits: { chunkPatchLines: 800 }", NO_AGENT_SETTINGS).limits.chunkPatchLines, 800);
  });
});

describe("the base branch's model choice (F-7, C-3)", () => {
  const pick = async (enabledModels: string[], spec: string) =>
    (await configure({ enabledModels }, `roles: { reviewer: ${JSON.stringify(spec)} }`)).roles.reviewer;
  const allowed: Array<[why: string, pattern: string, spec: string, level?: string]> = [
    ["glob on provider/id", "openrouter/vendor/*", "openrouter/vendor/other"],
    ["glob on the bare id", "anthropic/*", "openrouter/anthropic/claude-x"],
    ["glob ignores case", "LOCAL/qwen-*", "local/Qwen-Big"],
    ["exact", "openrouter/vendor/model", "openrouter/vendor/model"],
    ["exact, any case", "local/qwen-big", "LOCAL/qwen-big"],
    ["bare id on each provider", "qwen-big", "local/Qwen-Big"],
    ["fuzzy", "claude-y", "anthropic/claude-y-20260101"],
    ["brackets in an id are no glob", "local/bracketed[1m]", "local/bracketed[1m]"],
    ["the pattern's level is the default", "openrouter/vendor/*:low", "openrouter/vendor/other", "low"],
    ["the YAML's suffix wins over it", "openrouter/vendor/*:low", "openrouter/vendor/other:max", "max"],
    ["an id with a colon", "openrouter/vendor/*", "openrouter/vendor/model:free"],
    ["an id with a colon and a suffix", "openrouter/vendor/*", "openrouter/vendor/model:free:high", "high"],
    ["an id ending in a level", "openrouter/vendor/*", "openrouter/vendor/odd:high"],
  ];
  for (const [why, pattern, spec, level] of allowed) {
    test(`allowed: ${why}`, async () => {
      const ref = (await pick([pattern], spec))!;
      const name = `${ref.provider}/${ref.id}`.toLowerCase();
      const expected = why.endsWith("suffix") || why.startsWith("the YAML's suffix") ? spec.replace(/:[a-z]+$/, "") : spec;
      assert.equal(name, expected.toLowerCase());
      assert.ok(CATALOG.some((m) => m.provider === ref.provider && m.id === ref.id), "spelled as pi spells it");
      assert.equal(ref.thinkingLevel, level);
    });
  }
  const refused: Array<[why: string, pattern: string, spec: string]> = [
    ["outside the glob", "openrouter/vendor/*", "openrouter/elsewhere/thing"],
    ["* stops at a slash", "openrouter/*", "openrouter/vendor/model"],
    ["an id pi does not know", "openrouter/vendor/*", "openrouter/vendor/invented"],
    ["an invented provider whose id matches", "anthropic/*", "evil/anthropic/claude-x"],
    ["the variant of an allowed id", "openrouter/vendor/model", "openrouter/vendor/model:free"],
    ["what brackets would match as a glob", "local/bracketed[1m]", "local/bracketed1"],
    ["no fuzzy match on the YAML's side", "openrouter/vendor/*", "openrouter/vendor/oth"],
    ["a bare id", "local/*", "Qwen-Big"],
    ["an ACP agent", "**", "acp/claude-code"],
  ];
  for (const [why, pattern, spec] of refused) {
    test(`refused: ${why}`, () => assert.rejects(pick([pattern], spec), /not in enabledModels/));
  }

  test("several patterns; a pattern that matches nothing is reported", async () => {
    const scope = await resolveEnabledModels(settingsOf({ enabledModels: ["local/Qwen-Big", "no-such-model", "anthropic/claude-x"] }), runtime);
    assert.deepEqual(scope.models, [{ provider: "local", id: "Qwen-Big" }, { provider: "anthropic", id: "claude-x" }]);
    assert.match(scope.warnings.join(), /no-such-model/);
  });

  test("without enabledModels the model is fixed", async () => {
    const fixed = { reviewBot: OPERATOR.reviewBot };
    for (const settings of [fixed, { ...fixed, enabledModels: [] }]) {
      for (const spec of ["openrouter/vendor/other", "openrouter/vendor/model:max", "openrouter/vendor/model:off"]) {
        await assert.rejects(configure(settings, `roles: { reviewer: "${spec}" }`), /the model is fixed/, spec);
      }
      await assert.rejects(configure({}, "roles: { verifier: anthropic/claude-x }"), /the model is fixed/, "adding a role is a change");
    }
    // Even a caller that resolved a list from somewhere else.
    const anyModel = [{ provider: "openrouter", id: "vendor/other" }];
    assert.throws(() => resolveConfig({}, "roles: { reviewer: openrouter/vendor/other }", settingsOf(fixed), anyModel), /the model is fixed/);
  });

  test("restating the configured model is no change and loses nothing", async () => {
    const inputs: ConfigInputs = { providers: { reviewer: ["one"] } };
    for (const spec of ["openrouter/vendor/model", "openrouter/vendor/model:high", "OpenRouter/Vendor/Model"]) {
      const c = await configure({ reviewBot: OPERATOR.reviewBot }, `roles: { reviewer: "${spec}" }`, inputs);
      assert.deepEqual(c.roles.reviewer, { provider: "openrouter", id: "vendor/model", thinkingLevel: "high", routing: { only: ["one"], allow_fallbacks: false } }, spec);
    }
    const outside = await configure(OPERATOR, "roles: { verifier: anthropic/claude-x }");
    assert.deepEqual(outside.roles.verifier, { provider: "anthropic", id: "claude-x" }, "even outside enabledModels");
    const off = await configure({ reviewBot: OPERATOR.reviewBot }, 'roles: { verifier: "anthropic/claude-x:off" }');
    assert.deepEqual(off.roles.verifier, outside.roles.verifier, "off is the default");
  });

  test("a changed model keeps the operator's provider restriction (C-6)", async () => {
    const c = await configure(OPERATOR, "roles: { reviewer: openrouter/vendor/other }", { providers: { reviewer: ["one"] } });
    assert.deepEqual(c.roles.reviewer, { provider: "openrouter", id: "vendor/other", routing: { only: ["one"], allow_fallbacks: false } });
  });

  test("patterns that were never resolved allow nothing", () => {
    assert.throws(() => resolveConfig({}, "roles: { reviewer: openrouter/vendor/other }", settingsOf(OPERATOR)), /not in enabledModels/);
  });
});

describe("a hostile base branch (C-3, D-19)", () => {
  test("every escalation in one file is refused at once and named", async () => {
    const yaml = [
      "roles:",
      "  reviewer: { model: openrouter/elsewhere/thing }",
      "  verifier: evil/anthropic/claude-x",
      "limits:",
      "  reviewer: { timeoutSeconds: 99999, idleTimeoutSeconds: 99999, maxTurns: 100000 }",
      "  verifier: { timeoutSeconds: 99999, idleTimeoutSeconds: 99999, maxTurns: 100000 }",
      "  runCostUsd: 100000",
      "  runTimeoutSeconds: 99999",
      "  chunkPatchLines: 1",
    ].join("\n");
    await assert.rejects(configure(OPERATOR, yaml), (e: Error) => {
      assert.ok(e instanceof ConfigError);
      for (const key of [
        "roles.reviewer ",
        "roles.verifier ",
        "limits.reviewer.timeoutSeconds",
        "limits.reviewer.idleTimeoutSeconds",
        "limits.reviewer.maxTurns",
        "limits.verifier.timeoutSeconds",
        "limits.verifier.idleTimeoutSeconds",
        "limits.verifier.maxTurns",
        "limits.runCostUsd",
        "limits.runTimeoutSeconds",
        "limits.chunkPatchLines",
      ]) {
        assert.ok(e.message.includes(key), key);
      }
      return true;
    });
  });

  test("thinking, providers and routing do not exist, even on an allowed model (H-45)", async () => {
    for (const field of ["thinking: low", "providers: [one]", "routing: { sort: price }"]) {
      await assert.rejects(configure(OPERATOR, `roles: { reviewer: { model: openrouter/vendor/other, ${field} } }`), /review-bot\.yaml is invalid: \/roles\/reviewer/, field);
    }
  });

  test("there is no key for tools, packages, providers, endpoints or the allow-list", async () => {
    for (const yaml of [
      'roles: { reviewer: { model: openrouter/vendor/model, tools: ["+bash"] } }',
      "roles: { reviewer: { model: openrouter/vendor/model, baseUrl: 'https://evil.invalid' } }",
      "roles: { learner: openrouter/vendor/model }",
      "tools: [bash]",
      "defaultTools: [bash]",
      "packages: ['npm:evil@1.0.0']",
      "extensions: [./evil.ts]",
      "providers: { evil: { baseUrl: 'https://evil.invalid' } }",
      "models: [evil/model]",
      "enabledModels: ['**']",
      "reviewBot: { limits: { runCostUsd: 999 } }",
      "__proto__: { limits: { runCostUsd: 999 } }",
      "limits: { runCostUsd: .inf }",
      "limits: { runCostUsd: .nan }",
      "limits: { runCostUsd: '999' }",
    ]) {
      await assert.rejects(configure(OPERATOR, yaml), /review-bot\.yaml is invalid/, yaml);
    }
  });

  test("a quoted value cannot mention anyone, inject HTML or add a line", async () => {
    const spec = JSON.stringify("openrouter/x @everyone `x`\n<!-- review-bot:summary -->");
    await assert.rejects(configure(OPERATOR, `roles: { reviewer: ${spec} }`), (e: Error) => !/[<>@`\n]/.test(e.message));
  });

  test("skip, CI wait and authorization stay the repository's own", async () => {
    const yaml = [
      "skip: { draft: false, labels: [hold], optOutLabels: [no-bot], roundCapLabels: [cap], dependencies: { labels: [bump], paths: [go.mod] } }",
      "ci: { require: [build], onFailure: review, timeout: 2h }",
      "authorization: { label: ok-to-review, lifetime: per-pr }",
    ].join("\n");
    const c = await configure({ ...OPERATOR, reviewBot: { ...OPERATOR.reviewBot, skip: { draft: true, labels: ["wip"] } } }, yaml, { skipDraft: true });
    assert.deepEqual(c.skip, { draft: false, labels: ["hold"], optOutLabels: ["no-bot"], roundCapLabels: ["cap"], dependencies: { labels: ["bump"], paths: ["go.mod"] } });
  });

  test("in a run: neutral, the refusal in the check and the comment, no model call (S-9)", async () => {
    const dir = join(work, "hostile-pr");
    cpSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "prs", "basic"), dir, { recursive: true });
    writeFileSync(join(dir, "base", ".review", "review-bot.yaml"), "limits: { runCostUsd: 100000 }\n");
    const fixture = new FixturePrReader(dir);
    const platform = new DryRunPlatform(fixture);
    const scripted = createScriptedProvider({ reviewer: [{ text: "must not be called" }] });
    const result = await runReview({
      platform,
      snapshots: fixture.snapshots(),
      agentStep: createPiSdkAgentStep({ providers: [scripted.provider], retry: { enabled: false } }),
      inputs: { models: { reviewer: "scripted/reviewer" } },
      runsDir: join(work, "runs"),
    });
    const expected = /refused: limits\.runCostUsd 100000 \(at most 5\)/;
    assert.equal(result.conclusion, "neutral");
    assert.match(result.checkSummary, expected);
    assert.match(JSON.stringify(platform.output), /Automated review could not complete[^"]*refused: limits\.runCostUsd/);
    assert.deepEqual(scripted.calls, []);
  });
});
