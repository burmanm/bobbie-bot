/** Waiting for CI (C-9): evaluation, the gate table, re-triggers and the sweep. No network. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type CiFacts, DEFAULT_CI_WAIT, evaluateCi, parseCiRequire, parseCiTimeout } from "./ci-wait.ts";
import { type GateConfig, type GateEvent, gateEventFrom, resolveGateConfig, runGate, STALE_IN_PROGRESS_MS } from "./gate.ts";
import { Github } from "./github.ts";
import { fakeGithub, type FakeRepo, SHA_A, SHA_B, SHA_C } from "./testing.ts";

const LABEL = "ai-review/approved";
const NOW = new Date("2026-11-20T12:00:00Z");
const now = () => NOW;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3_600_000;
const SHA_D = "d".repeat(40);

const facts = (over: Partial<CiFacts> = {}): CiFacts => ({ checkRuns: [], statuses: [], workflowRuns: [], ...over });

test("evaluateCi: success, skipped and neutral pass; a status, a check run or a workflow can be named", () => {
  const r = evaluateCi(["build", "lint", "ci/jenkins", "CI"], facts({
    checkRuns: [
      { name: "build", status: "completed", conclusion: "success", completedAt: "2026-11-20T10:00:00Z" },
      { name: "lint", status: "completed", conclusion: "skipped", completedAt: "2026-11-20T10:05:00Z" },
    ],
    statuses: [{ context: "ci/jenkins", state: "success", updatedAt: "2026-11-20T10:07:00Z" }],
    workflowRuns: [
      { id: 1, name: "CI", status: "completed", conclusion: "failure", updatedAt: "2026-11-20T09:00:00Z" },
      { id: 2, name: "CI", status: "completed", conclusion: "neutral", updatedAt: "2026-11-20T10:06:00Z" },
    ],
  }));
  assert.equal(r.state, "passed");
  assert.deepEqual(r.passed, ["build", "lint", "ci/jenkins", "CI"]);
  assert.equal(r.completedAt, "2026-11-20T10:07:00Z");
});

test("evaluateCi: a failure decides even while others are pending; unreported and action_required are pending", () => {
  const f = facts({
    checkRuns: [
      { name: "build", status: "completed", conclusion: "timed_out" },
      { name: "e2e", status: "in_progress", conclusion: null },
      { name: "fork-run", status: "completed", conclusion: "action_required" },
    ],
    statuses: [{ context: "ci/ext", state: "error" }],
  });
  const r = evaluateCi(["build", "e2e", "fork-run", "ci/ext", "never"], f);
  assert.equal(r.state, "failed");
  assert.deepEqual(r.failed, ["build", "ci/ext"]);
  assert.deepEqual(r.pending, ["e2e", "fork-run", "never"]);
  assert.equal(evaluateCi(["e2e", "never"], f).state, "pending");
  assert.equal(evaluateCi(["e2e", "never"], f).completedAt, undefined);
});

test("evaluateCi: ai-review/* checks are never required; nothing required passes", () => {
  const r = evaluateCi(["ai-review/main", "ai-review/other"], facts());
  assert.equal(r.state, "passed");
  assert.deepEqual(r.required, []);
});

test("config: ci.require / ci.onFailure / ci.timeout from the base branch's YAML override the inputs", () => {
  assert.equal(parseCiRequire("off"), "off");
  assert.equal(parseCiRequire("required"), "required");
  assert.deepEqual(parseCiRequire("build, lint\nbuild"), ["build", "lint"]);
  assert.equal(parseCiTimeout("6h"), 6 * HOUR);
  assert.equal(parseCiTimeout(90), 90_000);
  assert.throws(() => parseCiTimeout("soon"));
  const inputs: GateConfig = { name: "main", label: LABEL, lifetime: "per-push", ci: DEFAULT_CI_WAIT };
  const c = resolveGateConfig(inputs, "ci:\n  require: [build, lint]\n  onFailure: review\n  timeout: 90m\n", () => {});
  assert.deepEqual(c.ci, { require: ["build", "lint"], onFailure: "review", timeoutMs: 90 * 60_000 });
  assert.deepEqual(resolveGateConfig(inputs, "ci:\n  require: required\n", () => {}).ci, { ...DEFAULT_CI_WAIT, require: "required" });
  assert.deepEqual(resolveGateConfig({ ...inputs, ci: { ...DEFAULT_CI_WAIT, require: ["x"] } }, "ci:\n  require: off\n", () => {}).ci.require, "off");
  const warnings: string[] = [];
  assert.deepEqual(resolveGateConfig(inputs, "ci:\n  wait: yes\n", (l) => void warnings.push(l)).ci, DEFAULT_CI_WAIT);
  assert.equal(warnings.length, 1);
});

// ---- the gate on a PR event ------------------------------------------------

function repo(yaml: string, over: Partial<FakeRepo> = {}): FakeRepo {
  return {
    pulls: { 7: { number: 7, user: { login: "maint" }, labels: [], head: SHA_A, base: SHA_B } },
    roles: { maint: "maintain", writer: "write", reader: "read" },
    files: { [`.review/review-bot.yaml@${SHA_B}`]: yaml },
    ...over,
  };
}

const inputs: GateConfig = { name: "main", label: LABEL, lifetime: "per-push", ci: DEFAULT_CI_WAIT };
const ev = (action: string, over: Partial<GateEvent> = {}): GateEvent => ({ name: "pull_request_target", action, sender: "maint", prNumber: 7, headSha: SHA_A, ...over });
const client = (r: FakeRepo) => {
  const f = fakeGithub(r);
  return { gh: new Github({ token: "t", repo: "o/r", fetch: f.fetch }), calls: f.calls };
};
const ours = (r: FakeRepo, sha = SHA_A) => (r.checks ?? []).filter((c) => c.name === "ai-review/main" && c.head_sha === sha);

test("gate: CI pending → ai-review/<name> queued with the names, nothing else (no review)", async () => {
  const r = repo("ci:\n  require: [build, lint]\n", { checks: [{ id: 1, name: "build", head_sha: SHA_A, status: "in_progress", conclusion: null }] });
  const { gh } = client(r);
  const res = await runGate(gh, ev("opened"), inputs, () => {}, { now });
  assert.equal(res.decision.kind, "wait");
  assert.equal(res.waiting, undefined);
  const [check] = ours(r);
  assert.equal(check?.status, "queued");
  assert.equal(check?.started_at, NOW.toISOString());
  assert.equal(check?.output?.title, "Waiting for CI");
  assert.match(check!.output!.summary, /^Waiting for CI: build, lint\./);

  // A later event at the same head while still waiting updates the same check.
  const again = await runGate(gh, ev("ready_for_review"), inputs, () => {}, { now: () => new Date(NOW.getTime() + HOUR) });
  assert.equal(again.decision.kind, "wait");
  assert.equal(ours(r).length, 1);
});

test("gate: CI passed → review; head-seen time is the queued check's, CI completion is recorded", async () => {
  const r = repo("ci:\n  require: [build]\n", {
    checks: [
      { id: 5, name: "ai-review/main", head_sha: SHA_A, status: "queued", conclusion: null, started_at: ago(2 * HOUR) },
      { id: 1, name: "build", head_sha: SHA_A, status: "completed", conclusion: "success", completed_at: ago(HOUR) },
    ],
  });
  const res = await runGate(client(r).gh, ev("labeled", { label: "other" }), inputs, () => {}, { now });
  // An unrelated label is ignored before CI is looked at…
  assert.equal(res.decision.kind, "ignore");
  const res2 = await runGate(client(r).gh, ev("ready_for_review"), inputs, () => {}, { now });
  assert.equal(res2.decision.kind, "review");
  assert.deepEqual(res2.waiting, { headSeenAt: ago(2 * HOUR), ci: "passed", required: ["build"], ciCompletedAt: ago(HOUR) });
});

test("gate: CI failed → skipped 'CI failed: …' (ci.onFailure skip), or reviewed and said so (review)", async () => {
  const failing = { checks: [{ id: 1, name: "build", head_sha: SHA_A, status: "completed", conclusion: "failure", completed_at: ago(HOUR) }] };
  const r = repo("ci:\n  require: [build]\n", structuredClone(failing));
  const res = await runGate(client(r).gh, ev("synchronize"), inputs, () => {}, { now });
  assert.equal(res.decision.kind, "skip");
  assert.equal(res.checkCompleted, true);
  const [check] = ours(r);
  assert.deepEqual([check?.status, check?.conclusion, check?.output?.title, check?.output?.summary], ["completed", "skipped", "Skipped: CI failed", "CI failed: build."]);

  const r2 = repo("ci:\n  require: [build]\n  onFailure: review\n", structuredClone(failing));
  const res2 = await runGate(client(r2).gh, ev("synchronize"), inputs, () => {}, { now });
  assert.equal(res2.decision.kind, "review");
  assert.equal(res2.waiting?.ci, "failed");
  assert.deepEqual(res2.waiting?.failed, ["build"]);
  assert.match(res2.decision.reason, /reviewed anyway/);
  assert.equal(ours(r2).length, 0);
});

test("gate: `required` = classic protection + rulesets of the base branch, minus ai-review/*", async () => {
  const r = repo("ci:\n  require: required\n", {
    protection: { release: ["build", "ai-review/main"] },
    rulesets: { release: ["lint", "ai-review/other"] },
    statuses: [{ sha: SHA_A, context: "lint", state: "pending" }],
    checks: [{ id: 1, name: "build", head_sha: SHA_A, status: "completed", conclusion: "success" }],
  });
  r.pulls[7]!.baseRef = "release";
  const res = await runGate(client(r).gh, ev("opened"), inputs, () => {}, { now });
  assert.equal(res.decision.kind, "wait");
  assert.match(ours(r)[0]!.output!.summary, /^Waiting for CI: lint\. The review starts when the required checks \(build, lint\)/);

  const none = repo("ci:\n  require: required\n");
  const res2 = await runGate(client(none).gh, ev("opened"), inputs, () => {}, { now });
  assert.equal(res2.decision.kind, "review");
  assert.equal(res2.waiting?.ci, "not-required");
});

test("gate: unreadable CI does not leave the PR waiting forever; it is reviewed and the record says so", async () => {
  const r = repo("ci:\n  require: required\n", { forbidden: ["/branches/"] });
  const lines: string[] = [];
  const res = await runGate(client(r).gh, ev("opened"), inputs, (l) => void lines.push(l), { now });
  assert.equal(res.decision.kind, "review");
  assert.equal(res.waiting?.ci, "unavailable");
  assert.ok(lines.some((l) => /could not read the required CI checks/.test(l)));
});

test("gate: workflow names need the workflow-runs API; without actions: read they stay pending", async () => {
  const r = repo("ci:\n  require: [Tests]\n", { workflowRuns: [{ id: 3, head_sha: SHA_A, name: "Tests", status: "completed", conclusion: "success" }] });
  assert.equal((await runGate(client(r).gh, ev("opened"), inputs, () => {}, { now })).decision.kind, "review");
  const r2 = repo("ci:\n  require: [Tests]\n", { forbidden: ["/actions/"], workflowRuns: r.workflowRuns! });
  assert.equal((await runGate(client(r2).gh, ev("opened"), inputs, () => {}, { now })).decision.kind, "wait");
});

test("gate: CI wait off (the default) makes no CI calls; dispatch with ignore-ci skips the wait", async () => {
  const r = repo("");
  const { gh, calls } = client(r);
  const res = await runGate(gh, ev("opened"), inputs, () => {}, { now });
  assert.equal(res.decision.kind, "review");
  assert.equal(res.waiting?.ci, "not-required");
  assert.ok(!calls.some((c) => /\/status|\/branches|\/rules|\/actions/.test(c.path)));

  const waiting = repo("ci:\n  require: [build]\n");
  const d = await runGate(client(waiting).gh, { name: "workflow_dispatch", sender: "maint", prNumber: 7, ignoreCi: true }, inputs, () => {}, { now });
  assert.equal(d.decision.kind, "review");
  assert.equal(d.waiting?.ci, "ignored");
});

test("gate: a push supersedes the previous head's queued check", async () => {
  const r = repo("ci:\n  require: [build]\n", {
    checks: [
      { id: 9, name: "ai-review/main", head_sha: SHA_C, status: "queued", conclusion: null, started_at: ago(HOUR) },
      { id: 8, name: "ai-review/main", head_sha: SHA_D, status: "in_progress", conclusion: null },
    ],
  });
  await runGate(client(r).gh, ev("synchronize", { before: SHA_C }), inputs, () => {}, { now });
  const old = ours(r, SHA_C)[0]!;
  assert.deepEqual([old.status, old.conclusion, old.output?.title], ["completed", "skipped", "Superseded by a newer push"]);
  // Only queued checks: a running review is cancelled by the concurrency group and completes its own.
  await runGate(client(r).gh, ev("synchronize", { before: SHA_D }), inputs, () => {}, { now });
  assert.equal(ours(r, SHA_D)[0]!.status, "in_progress");
});

test("gate: an outsider waiting for CI whose authorization is revoked gets the queued check completed", async () => {
  const r = repo("ci:\n  require: [build]\n", { checks: [{ id: 5, name: "ai-review/main", head_sha: SHA_A, status: "queued", conclusion: null, started_at: ago(HOUR) }] });
  r.pulls[7]!.user.login = "outsider";
  await runGate(client(r).gh, ev("reopened"), inputs, () => {}, { now });
  const [check] = ours(r);
  assert.deepEqual([check?.id, check?.status, check?.conclusion], [5, "completed", "skipped"]);
});

// ---- re-triggers and the sweep -----------------------------------------------

test("payloads: workflow_run and status give only a SHA; the PR list and branch names are not used", () => {
  const wr = gateEventFrom("workflow_run", {
    action: "completed",
    sender: { login: "x" },
    workflow_run: { head_sha: SHA_A, head_branch: "$(evil)", pull_requests: [{ number: 99 }] },
  });
  assert.deepEqual(wr, { name: "workflow_run", sender: "x", headSha: SHA_A });
  assert.deepEqual(gateEventFrom("status", { sha: SHA_B, context: "ci", state: "success", branches: [{ name: "x" }] }), { name: "status", sender: "", headSha: SHA_B });
  assert.deepEqual(gateEventFrom("schedule", { schedule: "*/30 * * * *" }), { name: "schedule", sender: "" });
  const sync = gateEventFrom("pull_request_target", { action: "synchronize", before: SHA_C, pull_request: { number: 7, head: { sha: SHA_A } } });
  assert.equal(sync.before, SHA_C);
  assert.equal(gateEventFrom("workflow_dispatch", { inputs: { pr: "7", "ignore-ci": true } }).ignoreCi, true);
  assert.equal(gateEventFrom("workflow_dispatch", { inputs: { pr: "7", "ignore-ci": false } }).ignoreCi, undefined);
});

function forkRepo(): FakeRepo {
  return {
    pulls: {
      7: { number: 7, user: { login: "outsider" }, labels: [LABEL], head: SHA_A, base: SHA_B },
      8: { number: 8, user: { login: "maint" }, labels: [], head: SHA_C, base: SHA_B },
      9: { number: 9, user: { login: "maint" }, labels: [], head: SHA_D, base: SHA_B, state: "closed" },
    },
    roles: { maint: "maintain" },
    events: { 7: [{ event: "labeled", label: LABEL, actor: "maint" }] },
    files: { [`.review/review-bot.yaml@${SHA_B}`]: "ci:\n  require: [build]\n" },
    checks: [
      { id: 50, name: "ai-review/main", head_sha: SHA_A, status: "queued", conclusion: null, started_at: ago(HOUR) },
      { id: 51, name: "build", head_sha: SHA_A, status: "completed", conclusion: "success", completed_at: ago(60_000) },
    ],
  };
}

test("workflow_run: the fork PR is found by head SHA, claimed, and reviewed; a second event leaves it alone", async () => {
  const r = forkRepo();
  const { gh } = client(r);
  const res = await runGate(gh, { name: "workflow_run", sender: "x", headSha: SHA_A }, inputs, () => {}, { now });
  assert.equal(res.decision.kind, "review");
  assert.equal(res.decision.kind === "review" && res.decision.via, "label");
  assert.equal(res.pr?.number, 7);
  assert.deepEqual(res.waiting, { headSeenAt: ago(HOUR), ci: "passed", required: ["build"], ciCompletedAt: ago(60_000), resumedBy: "workflow_run" });
  assert.equal(ours(r)[0]!.status, "in_progress");
  const again = await runGate(gh, { name: "status", sender: "x", headSha: SHA_A }, inputs, () => {}, { now });
  assert.equal(again.decision.kind, "ignore");
});

test("workflow_run / status: a SHA that is no PR's head, or a PR not waiting, changes nothing", async () => {
  const r = forkRepo();
  const { gh, calls } = client(r);
  for (const sha of [SHA_D, "f".repeat(40), SHA_C]) {
    const res = await runGate(gh, { name: "workflow_run", sender: "x", headSha: sha }, inputs, () => {}, { now });
    assert.equal(res.decision.kind, "ignore", sha);
  }
  assert.equal((await runGate(gh, { name: "status", sender: "x", headSha: "not-a-sha" }, inputs, () => {}, { now })).decision.kind, "ignore");
  assert.ok(!calls.some((c) => c.method !== "GET"));
});

test("resume: CI still pending stays queued; CI failed completes it; the label removed meanwhile completes it", async () => {
  const pending = forkRepo();
  pending.checks![1] = { ...pending.checks![1]!, status: "in_progress", conclusion: null };
  assert.equal((await runGate(client(pending).gh, { name: "workflow_run", sender: "x", headSha: SHA_A }, inputs, () => {}, { now })).decision.kind, "ignore");
  assert.equal(ours(pending)[0]!.status, "queued");

  const failed = forkRepo();
  failed.checks![1] = { ...failed.checks![1]!, conclusion: "failure" };
  await runGate(client(failed).gh, { name: "workflow_run", sender: "x", headSha: SHA_A }, inputs, () => {}, { now });
  assert.deepEqual([ours(failed)[0]!.conclusion, ours(failed)[0]!.output?.summary], ["skipped", "CI failed: build."]);

  const revoked = forkRepo();
  revoked.pulls[7]!.labels = [];
  await runGate(client(revoked).gh, { name: "status", sender: "x", headSha: SHA_A }, inputs, () => {}, { now });
  assert.deepEqual([ours(revoked)[0]!.status, ours(revoked)[0]!.conclusion], ["completed", "skipped"]);
});

test("sweep: times out checks queued longer than ci.timeout, ends dead in-progress ones, resumes one ready PR", async () => {
  const r = forkRepo();
  r.files![`.review/review-bot.yaml@${SHA_B}`] = "ci:\n  require: [build]\n  timeout: 2h\n";
  r.pulls[10] = { number: 10, user: { login: "maint" }, labels: [], head: "1".repeat(40), base: SHA_B };
  r.pulls[11] = { number: 11, user: { login: "maint" }, labels: [], head: "2".repeat(40), base: SHA_B };
  r.pulls[12] = { number: 12, user: { login: "maint" }, labels: [], head: "3".repeat(40), base: SHA_B };
  r.checks!.push(
    // #8: waiting 3 h, CI never reported → skipped
    { id: 60, name: "ai-review/main", head_sha: SHA_C, status: "queued", conclusion: null, started_at: ago(3 * HOUR) },
    // #10: waiting 1 h, CI never reported → stays queued
    { id: 61, name: "ai-review/main", head_sha: "1".repeat(40), status: "queued", conclusion: null, started_at: ago(HOUR) },
    // #11: in progress far longer than any job → neutral
    { id: 62, name: "ai-review/main", head_sha: "2".repeat(40), status: "in_progress", conclusion: null, started_at: ago(STALE_IN_PROGRESS_MS + HOUR) },
    // #12: ready as well, but only one PR is resumed per run
    { id: 63, name: "ai-review/main", head_sha: "3".repeat(40), status: "queued", conclusion: null, started_at: ago(HOUR) },
    { id: 64, name: "build", head_sha: "3".repeat(40), status: "completed", conclusion: "success" },
  );
  const res = await runGate(client(r).gh, { name: "schedule", sender: "" }, inputs, () => {}, { now });
  assert.equal(res.decision.kind, "review");
  assert.equal(res.pr?.number, 7);
  assert.equal(res.waiting?.resumedBy, "schedule");
  const byId = (id: number) => r.checks!.find((c) => c.id === id)!;
  assert.deepEqual([byId(60).status, byId(60).conclusion, byId(60).output?.title], ["completed", "skipped", "Skipped: CI did not report"]);
  assert.match(byId(60).output!.summary, /^CI did not report within 2 h: build/);
  assert.equal(byId(61).status, "queued");
  assert.deepEqual([byId(62).status, byId(62).conclusion], ["completed", "neutral"]);
  assert.equal(byId(63).status, "queued");
  // The next sweep picks up #12.
  const next = await runGate(client(r).gh, { name: "schedule", sender: "" }, inputs, () => {}, { now });
  assert.equal(next.pr?.number, 12);
});

test("sweep: a check left queued after ci.require was turned off is resumed, not stranded", async () => {
  const r = forkRepo();
  r.files![`.review/review-bot.yaml@${SHA_B}`] = "";
  r.checks!.pop();
  const res = await runGate(client(r).gh, { name: "schedule", sender: "" }, inputs, () => {}, { now });
  assert.equal(res.decision.kind, "review");
  assert.equal(res.waiting?.ci, "not-required");
});

test("CLI gate: --ci-* inputs, the waiting JSON output for the review job, --ignore-ci only on dispatch", async () => {
  const { runCi } = await import("../cli/ci.ts");
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "review-bot-gate-"));
  try {
    const r = forkRepo();
    r.files![`.review/review-bot.yaml@${SHA_B}`] = "";
    const f = fakeGithub(r);
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify({ workflow_run: { head_sha: SHA_A, pull_requests: [] }, sender: { login: "x" } }));
    const out = join(dir, "out");
    writeFileSync(out, "");
    const err: string[] = [];
    const io = { stdout: () => {}, stderr: (s: string) => void err.push(s) };
    const env = { GH_TOKEN: "t", GITHUB_REPOSITORY: "o/r", GITHUB_EVENT_NAME: "workflow_run", GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: out };
    const code = await runCi("gate", ["--ci-require", "build", "--ci-timeout", "3h"], io, { env, fetch: f.fetch });
    assert.equal(code, 0, err.join(""));
    const lines = Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    assert.equal(lines.review, "true");
    assert.equal(lines.pr, "7");
    assert.equal(lines["head-sha"], SHA_A);
    const waiting = JSON.parse(lines.waiting!) as { ci: string; resumedBy: string; required: string[] };
    assert.deepEqual([waiting.ci, waiting.resumedBy, waiting.required], ["passed", "workflow_run", ["build"]]);

    assert.equal(await runCi("gate", ["--ignore-ci"], io, { env, fetch: f.fetch }), 2);
    assert.equal(await runCi("gate", ["--ci-on-failure", "maybe"], io, { env, fetch: f.fetch }), 2);
    assert.equal(await runCi("gate", ["--ci-timeout", "soon"], io, { env, fetch: f.fetch }), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
