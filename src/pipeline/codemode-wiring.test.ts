/**
 * R-1a step 5b in the run (F-7 Codemode, A-6): codemode is enabled by the
 * operator's settings.json only, `.review/review-bot.yaml` can only turn it
 * off, every script the run executed lands scrubbed in `scripts.json` next
 * to the record, and a finding reported from a script keeps its id.
 * Against pi's scripted model: no network, no key (AGENTS.md).
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { Value } from "typebox/value";
import { createPiSdkAgentStep, createScriptedProvider, type Script } from "../agent/index.ts";
import { RunRecord } from "../core/index.ts";
import { SAVED_SCRIPTS_FILE, SavedScripts } from "../core/saved-scripts.ts";
import { DryRunPlatform, FixturePrReader } from "../platform/index.ts";
import { NO_AGENT_SETTINGS, parseAgentSettings, resolveRoleTools } from "./agent-settings.ts";
import { ConfigError, resolveConfig } from "./config.ts";

import { runReview } from "./run.ts";

const BASIC = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "prs", "basic");
const work = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-codemode-wiring-")));
after(() => rmSync(work, { recursive: true, force: true }));

const ON = { reviewBot: { roles: { reviewer: { tools: ["+codemode"] } } } };

describe("configuration (F-7): settings.json enables, the base branch's YAML only narrows", () => {
  const tools = (settings: object, yaml?: string) =>
    resolveRoleTools(resolveConfig({}, yaml, parseAgentSettings(JSON.stringify(settings))).tools.reviewer, ["read"]);

  test("off by default; on with +codemode in a role's tools", () => {
    assert.deepEqual(tools({}), ["read"]);
    assert.deepEqual(tools(ON), ["read", "codemode"]);
  });

  test("the YAML turns it off for every role", () => {
    assert.deepEqual(tools(ON, "codemode: false\n"), ["read"]);
    const c = resolveConfig({}, "codemode: false\n", parseAgentSettings(JSON.stringify(ON)));
    assert.deepEqual(resolveRoleTools(c.tools.verifier, ["read"]), ["read"]);
  });

  test("the YAML cannot turn it on; restating settings.json is accepted", () => {
    assert.throws(() => resolveConfig({}, "codemode: true\n", NO_AGENT_SETTINGS), (e: unknown) => e instanceof ConfigError && /can only narrow.*codemode true/.test(e.message));
    assert.deepEqual(tools(ON, "codemode: true\n"), ["read", "codemode"]);
    assert.throws(() => resolveConfig({}, "tools: [codemode]\n", NO_AGENT_SETTINGS), ConfigError);
  });

  test("pi's codemode key and reviewBot.codemode are read; models stays off unless set", () => {
    assert.equal(parseAgentSettings("{}").codemode, undefined);
    assert.deepEqual(parseAgentSettings(JSON.stringify({ codemode: { mode: "only", inlineBudget: 100 } })).codemode, { mode: "only", inlineBudget: 100 });
    assert.deepEqual(parseAgentSettings(JSON.stringify({ reviewBot: { codemode: { models: true } } })).codemode, { models: true });
    assert.throws(() => parseAgentSettings(JSON.stringify({ codemode: { mode: "always" } })), ConfigError);
    assert.throws(() => parseAgentSettings(JSON.stringify({ reviewBot: { codemode: { timeout: 1 } } })), ConfigError);
  });
});

describe("a run with codemode (A-6 scripts.json)", () => {
  const finding = (JSON.parse(readFileSync(join(BASIC, "script.json"), "utf8")) as { reviewer: Array<{ toolCalls: Array<{ arguments: unknown }> }> })
    .reviewer[0]!.toolCalls[0]!.arguments;
  const token = ["gh", "p_", "Z9y8".repeat(9)].join("");

  let n = 0;
  async function run(settings: object, yaml?: string) {
    const dir = join(work, `case-${n++}`);
    const agent = join(dir, "agent");
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "settings.json"), JSON.stringify(settings));
    const pr = join(dir, "pr");
    cpSync(BASIC, pr, { recursive: true });
    if (yaml !== undefined) {
      mkdirSync(join(pr, "base", ".review"), { recursive: true });
      writeFileSync(join(pr, "base", ".review", "review-bot.yaml"), yaml);
    }
    const script: Script = {
      reviewer: [
        { toolCalls: [{ name: "codemode", arguments: { code: `const src = await tools.read({ path: "pkg/store/store.go" });\nawait tools.report_finding(${JSON.stringify(finding)});\nreturn src.length` } }] },
        { toolCalls: [{ name: "codemode", arguments: { code: `const t = "a\\n${token}";\nreturn t.length` } }] },
        { text: "Done." },
      ],
    };
    const scripted = createScriptedProvider(script);
    const fixture = new FixturePrReader(pr);
    const platform = new DryRunPlatform(fixture);
    const parsed = parseAgentSettings(JSON.stringify(settings));
    const logs: string[] = [];
    const result = await runReview({
      platform,
      snapshots: fixture.snapshots(),
      agentStep: createPiSdkAgentStep({ providers: [scripted.provider], retry: { enabled: false }, abortGraceMs: 2_000, agentDir: agent, ...(parsed.codemode ? { codemode: parsed.codemode } : {}) }),
      inputs: { models: { reviewer: "scripted/reviewer" } },
      runsDir: join(dir, "runs"),
      agent: { dir: agent, settings: parsed },
      log: (l) => logs.push(l),
    });
    return { result, logs };
  }

  test("every script is saved, scrubbed, and the finding keeps its script's id", async () => {
    const { result, logs } = await run(ON);
    assert.notEqual(result.conclusion, "neutral", `${result.checkSummary}\n${logs.join("\n")}`);
    const record = JSON.parse(readFileSync(result.recordPath!, "utf8")) as RunRecord;
    assert.deepEqual([...Value.Errors(RunRecord, record)].map((e) => `${e.instancePath}: ${e.message}`), []);
    assert.deepEqual(record.run.versions.tools?.reviewer?.includes("codemode"), true);
    const fromScript = record.findings.find((f) => f.title === (finding as { title: string }).title);
    assert.equal(fromScript?.scriptId, "script-1", JSON.stringify(record.findings.map((f) => [f.title, f.scriptId])));

    assert.equal(result.scriptsPath, join(result.runDir!, SAVED_SCRIPTS_FILE));
    const text = readFileSync(result.scriptsPath!, "utf8");
    assert.ok(!text.includes(token), "a token reached scripts.json");
    const file = JSON.parse(text) as SavedScripts;
    assert.ok(Value.Check(SavedScripts, file), JSON.stringify([...Value.Errors(SavedScripts, file)]));
    assert.deepEqual(
      file.scripts.map((s) => [s.id, s.step, s.outcome, s.sourceRedacted, s.nestedCalls.map((c) => c.tool)]),
      [
        ["script-1", "review:all", "ok", false, ["read", "report_finding"]],
        ["script-2", "review:all", "ok", true, []],
      ],
    );
  });

  test("the base branch's YAML turns codemode off: no script runs, no scripts.json", async () => {
    const { result } = await run(ON, "codemode: false\n");
    const record = JSON.parse(readFileSync(result.recordPath!, "utf8")) as RunRecord;
    assert.ok(!record.run.versions.tools?.reviewer?.includes("codemode"));
    assert.ok(record.run.steps[0]!.rejectedCalls.some((r) => r.tool === "codemode"), JSON.stringify(record.run.steps[0]!.rejectedCalls));
    assert.equal(result.scriptsPath, undefined);
    assert.ok(!existsSync(join(result.runDir!, SAVED_SCRIPTS_FILE)));
  });

  test("the base branch's YAML cannot turn it on", async () => {
    const { result } = await run({}, "codemode: true\n");
    assert.equal(result.conclusion, "neutral");
    assert.match(result.checkSummary, /can only narrow.*codemode true/);
  });
});
