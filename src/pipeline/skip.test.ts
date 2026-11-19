/**
 * S-1 skip conditions: each completes the check as skipped with a reason
 * and writes a run record; configurable from inputs and
 * `.review/review-bot.yaml`. End to end on the fixture PR with the scripted
 * model (which must never be called). No network, no key.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { Value } from "typebox/value";
import { createPiSdkAgentStep, createScriptedProvider, type Script } from "../agent/index.ts";
import { parseDiff, RunRecord } from "../core/index.ts";
import { DryRunPlatform, FixturePrReader, type PrReader, type PullRequestInfo } from "../platform/index.ts";
import { type ConfigInputs, resolveConfig } from "./config.ts";
import { runReview } from "./run.ts";
import { DEFAULT_SKIP, dependencyLabelNote, dependencyOnlySkip, skipBeforeDiff } from "./skip.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "prs", "basic");
const work = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-skip-")));
after(() => rmSync(work, { recursive: true, force: true }));

const pr = (over: Partial<PullRequestInfo> = {}): PullRequestInfo => ({
  repo: "o/r",
  number: 1,
  title: "t",
  body: "",
  author: { login: "a", type: "User" },
  labels: [],
  draft: false,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  ...over,
});

const diffOf = (paths: string[]) => parseDiff(paths.map((p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-a\n+b\n`).join(""));

describe("skip conditions (S-1)", () => {
  const facts = { hasReviewMd: true };

  test("each condition, in order, with its kind and reason", () => {
    assert.equal(skipBeforeDiff(pr({ draft: true, labels: ["round-cap"] }), DEFAULT_SKIP, { hasReviewMd: false })?.kind, "not-onboarded");
    assert.equal(skipBeforeDiff(pr({ draft: true, labels: ["round-cap"] }), DEFAULT_SKIP, facts)?.kind, "draft");
    assert.deepEqual(skipBeforeDiff(pr({ labels: ["AI-Review/Skip", "round-cap"] }), DEFAULT_SKIP, facts), {
      kind: "opt-out",
      reason: 'the pull request has the opt-out label "AI-Review/Skip"',
    });
    assert.equal(skipBeforeDiff(pr({ labels: ["round-cap"] }), DEFAULT_SKIP, facts)?.kind, "round-cap");
    assert.equal(skipBeforeDiff(pr({ labels: ["wip"] }), { ...DEFAULT_SKIP, labels: ["wip"] }, facts)?.kind, "label");
    assert.equal(skipBeforeDiff(pr(), DEFAULT_SKIP, { hasReviewMd: true, lastReviewedSha: "b".repeat(40) })?.kind, "already-reviewed");
    assert.equal(skipBeforeDiff(pr({ labels: ["deps"] }), DEFAULT_SKIP, facts), undefined);
    assert.equal(skipBeforeDiff(pr({ draft: true }), { ...DEFAULT_SKIP, draft: false }, facts), undefined);
  });

  test("deps: skipped only when labelled and every changed path is a dependency file", () => {
    const deps = pr({ labels: ["deps"] });
    assert.equal(dependencyOnlySkip(deps, diffOf(["go.mod", "go.sum", "api/go.sum", "vendor/x/y.go"]), DEFAULT_SKIP)?.kind, "deps-only");
    assert.match(dependencyOnlySkip(deps, diffOf(["go.mod", "go.sum"]), DEFAULT_SKIP)!.reason, /label "deps" and changes only dependency files \(go.mod, go.sum\)/);
    assert.equal(dependencyOnlySkip(deps, diffOf(["go.mod", "main.go"]), DEFAULT_SKIP), undefined);
    assert.match(dependencyLabelNote(deps, diffOf(["go.mod", "main.go"]), DEFAULT_SKIP)!, /also changes main.go; reviewed/);
    assert.equal(dependencyOnlySkip(pr(), diffOf(["go.mod"]), DEFAULT_SKIP), undefined, "not labelled");
    assert.equal(dependencyOnlySkip(deps, [], DEFAULT_SKIP), undefined, "empty diff");
  });

  test("configurable from inputs, and the base yaml overrides them", () => {
    const inputs: ConfigInputs = { skip: { optOutLabels: ["no-bot"], dependencyLabels: ["dependencies"], dependencyPaths: ["*.lock"] } };
    const c = resolveConfig(inputs);
    assert.deepEqual(c.skip.optOutLabels, ["no-bot"]);
    assert.deepEqual(c.skip.dependencies, { labels: ["dependencies"], paths: ["*.lock"] });
    assert.deepEqual(c.skip.roundCapLabels, ["round-cap"]);
    const y = resolveConfig(inputs, "skip:\n  optOutLabels: [skip-ai]\n  roundCapLabels: [review/round-cap]\n  dependencies:\n    paths: [go.mod, go.sum]\n");
    assert.deepEqual(y.skip.optOutLabels, ["skip-ai"]);
    assert.deepEqual(y.skip.roundCapLabels, ["review/round-cap"]);
    assert.deepEqual(y.skip.dependencies, { labels: ["dependencies"], paths: ["go.mod", "go.sum"] });
    assert.throws(() => resolveConfig({}, "skip:\n  dependencies: { files: [x] }\n"), /invalid/);
    assert.notEqual(resolveConfig({}).skip.dependencies.paths, DEFAULT_SKIP.dependencies.paths, "defaults are copied, not shared");
  });
});

/** The fixture PR with its labels, draft state or diff replaced. */
function reader(over: Partial<PullRequestInfo>, diffPaths?: string[]): PrReader {
  const fixture = new FixturePrReader(FIXTURE);
  return {
    kind: "test",
    getPullRequest: async () => ({ ...(await fixture.getPullRequest()), ...over }),
    getDiff: async (since) => {
      const full = await fixture.getDiff(since);
      if (diffPaths === undefined || full === undefined) return full;
      return full
        .split(/(?=^diff --git )/m)
        .filter((part) => diffPaths.some((p) => part.startsWith(`diff --git a/${p} `)))
        .join("");
    },
    listComments: () => fixture.listComments(),
  };
}

async function run(r: PrReader, inputs: ConfigInputs = {}) {
  const fixture = new FixturePrReader(FIXTURE);
  const platform = new DryRunPlatform(r);
  const script: Script = JSON.parse(readFileSync(join(FIXTURE, "script.json"), "utf8")) as Script;
  const scripted = createScriptedProvider(script);
  const result = await runReview({
    platform,
    snapshots: fixture.snapshots(),
    agentStep: createPiSdkAgentStep({ providers: [scripted.provider], retry: { enabled: false } }),
    inputs: { models: { reviewer: "scripted/reviewer", verifier: "scripted/verifier" }, ...inputs },
    runsDir: join(work, "runs"),
  });
  const record = JSON.parse(readFileSync(result.recordPath!, "utf8")) as RunRecord;
  assert.deepEqual([...Value.Errors(RunRecord, record)].map((e) => e.message), []);
  return { result, platform, record, calls: scripted.calls };
}

describe("skipped runs end to end: skipped check, reason, record, no model call (S-1)", () => {
  const cases: Array<[string, Partial<PullRequestInfo>, string[] | undefined, string, RegExp]> = [
    ["draft", { draft: true }, undefined, "draft", /is a draft/],
    ["opt-out label (from the base yaml's list)", { labels: ["ai-review/skip"] }, undefined, "opt-out", /opt-out label "ai-review\/skip"/],
    ["round-cap label", { labels: ["round-cap"] }, undefined, "round-cap", /round cap was reached/],
    ["deps-labelled, dependency files only", { labels: ["deps"] }, ["go.sum"], "deps-only", /changes only dependency files \(go.sum\)/],
  ];
  for (const [name, over, paths, kind, reason] of cases) {
    test(name, async () => {
      const { result, platform, record, calls } = await run(reader(over, paths));
      assert.equal(result.conclusion, "skipped", result.checkSummary);
      assert.match(result.checkSummary, reason);
      assert.equal(platform.output.check_run?.conclusion, "skipped");
      assert.equal(platform.output.review, undefined);
      assert.deepEqual(calls, []);
      assert.equal(record.run.result.skipKind, kind);
      assert.match(record.run.result.skipReason!, reason);
      assert.equal(record.run.prNumber, 42);
    });
  }

  test("a deps-labelled PR that changes code is reviewed", async () => {
    const { result, record } = await run(reader({ labels: ["deps"] }));
    assert.equal(result.conclusion, "success", result.checkSummary);
    assert.equal(record.run.result.skipKind, undefined);
  });

  test("conditions are configurable from the inputs where the base yaml leaves them: drafts reviewed, another deps label", async () => {
    const draft = await run(reader({ draft: true }), { skipDraft: false });
    assert.equal(draft.result.conclusion, "success", draft.result.checkSummary);
    const deps = await run(reader({ labels: ["dependencies"] }, ["go.sum"]), { skip: { dependencyLabels: ["dependencies"] } });
    assert.equal(deps.result.conclusion, "skipped");
    assert.equal(deps.record.run.result.skipKind, "deps-only");
  });
});
