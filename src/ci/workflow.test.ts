/**
 * Structural checks of the reference workflow and the action (C-2 to C-5,
 * C-3a, S-8, S-9). Not a substitute for actionlint; these pin down the
 * security properties so a later edit cannot drop one silently.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

interface Step {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  "timeout-minutes"?: unknown;
}
interface Job {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  "timeout-minutes"?: unknown;
  steps: Step[];
}
interface Workflow {
  on: Record<string, { types?: string[]; inputs?: Record<string, { required?: boolean }> }>;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, Job>;
}

const wfText = read("workflows/review-bot.yml");
const wf = parse(wfText) as Workflow;
const action = parse(read("action/action.yml")) as { inputs: Record<string, unknown>; runs: { using: string; steps: Step[] } };
const ACTION = /^REVIEW_BOT_OWNER\/review-bot\/action@[0-9a-f]{40}$/;
const PINNED = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._/-]+)?@[0-9a-f]{40}$/;

const allSteps = (): Array<[string, Step]> => Object.entries(wf.jobs).flatMap(([j, job]) => job.steps.map((s) => [j, s] as [string, Step]));

test("triggers: pull_request_target with the C-2 actions, and manual dispatch with a PR number", () => {
  assert.deepEqual(Object.keys(wf.on).sort(), ["pull_request_target", "workflow_dispatch"]);
  assert.deepEqual(wf.on.pull_request_target!.types, ["opened", "reopened", "ready_for_review", "synchronize", "labeled"]);
  assert.equal(wf.on.workflow_dispatch!.inputs?.pr?.required, true);
});

test("no default token permissions; each job gets exactly its C-4 set", () => {
  assert.deepEqual(wf.permissions, {});
  assert.deepEqual(wf.jobs.gate!.permissions, { contents: "read", "pull-requests": "read", checks: "write" });
  assert.deepEqual(wf.jobs["remove-label"]!.permissions, { "pull-requests": "write" });
  assert.deepEqual(wf.jobs.prepare!.permissions, { contents: "read" });
  assert.deepEqual(wf.jobs.review!.permissions, { "pull-requests": "write", checks: "write" });
  assert.deepEqual(Object.keys(wf.jobs).sort(), ["gate", "prepare", "remove-label", "review"]);
});

test("concurrency per PR with cancel-in-progress (S-9); unrelated label events cancel nothing", () => {
  assert.equal(wf.concurrency["cancel-in-progress"], true);
  assert.match(wf.concurrency.group, /github\.event\.pull_request\.number \|\| inputs\.pr/);
  assert.match(wf.concurrency.group, /review-bot-ignored-\{0\}', github\.run_id/);
});

test("every job and the review step have a time limit; the review step's comes from a variable", () => {
  for (const [name, job] of Object.entries(wf.jobs)) assert.ok(job["timeout-minutes"] !== undefined, name);
  const review = wf.jobs.review!.steps.find((s) => s.id === "review")!;
  assert.match(String(review["timeout-minutes"]), /vars\.REVIEW_BOT_TIMEOUT_MINUTES/);
  assert.equal(review.with?.["timeout-minutes"], "${{ vars.REVIEW_BOT_TIMEOUT_MINUTES || '40' }}");
});

test("every action is pinned by full commit SHA; nothing checks out code", () => {
  const uses = [...allSteps().map(([, s]) => s.uses), ...action.runs.steps.map((s) => s.uses)].filter((u): u is string => u !== undefined);
  assert.ok(uses.length > 0);
  for (const u of uses) {
    assert.ok(PINNED.test(u) || ACTION.test(u), `not pinned by SHA: ${u}`);
    assert.doesNotMatch(u, /actions\/checkout/);
  }
  assert.doesNotMatch(wfText, /actions\/checkout/);
});

test("no expression is interpolated into a shell script (script injection)", () => {
  for (const [job, s] of allSteps()) assert.ok(s.run === undefined || !s.run.includes("${{"), `${job}: ${s.name}`);
  for (const s of action.runs.steps) assert.ok(s.run === undefined || !s.run.includes("${{"), String(s.name));
});

test("secrets: only the review job has the model key; prepare holds nothing", () => {
  const secretsIn = (job: Job) => JSON.stringify(job).match(/secrets\.[A-Z_]+/g) ?? [];
  assert.deepEqual(secretsIn(wf.jobs.prepare!), []);
  assert.ok(!JSON.stringify(wf.jobs.prepare).includes("steps.app"));
  for (const name of ["gate", "remove-label"]) {
    assert.deepEqual([...new Set(secretsIn(wf.jobs[name]!))], ["secrets.REVIEW_BOT_APP_PRIVATE_KEY"], name);
  }
  assert.deepEqual([...new Set(secretsIn(wf.jobs.review!))].sort(), ["secrets.OPENROUTER_API_KEY", "secrets.REVIEW_BOT_APP_PRIVATE_KEY"]);
  // The model key reaches exactly one step.
  const withKey = allSteps().filter(([, s]) => JSON.stringify(s).includes("OPENROUTER_API_KEY"));
  assert.deepEqual(withKey.map(([j, s]) => `${j}/${s.id}`), ["review/review"]);
});

test("both identities (C-5): every token is the App token when configured, else GITHUB_TOKEN; same in all jobs", () => {
  for (const [job, s] of allSteps()) {
    if (!s.uses || !ACTION.test(s.uses)) continue;
    const token = s.with?.token;
    if (job === "prepare") assert.equal(token, "${{ github.token }}");
    else assert.equal(token, "${{ steps.app.outputs.token || github.token }}", `${job}/${s.name}`);
  }
  for (const [job, s] of allSteps()) {
    if (s.uses?.startsWith("actions/create-github-app-token@")) assert.equal(s.if, "vars.REVIEW_BOT_APP_ID != ''", job);
  }
});

test("S-8, S-9: the check is completed and the record uploaded on every exit path", () => {
  const steps = wf.jobs.review!.steps;
  const complete = steps.find((s) => s.with?.command === "complete-check")!;
  assert.equal(complete.if, "always()");
  assert.equal(complete.with?.outcome, "${{ steps.review.outcome }}");
  const record = steps.find((s) => String(s.with?.name ?? "").startsWith("review-bot-record-"))!;
  assert.equal(record.if, "always()");
  assert.match(String(record.with?.path), /runs\/\*\/\*\.json$/);
  assert.equal(wf.jobs.review!.if, "${{ !cancelled() && needs.gate.outputs.review == 'true' }}");
  assert.ok(steps.indexOf(complete) > steps.findIndex((s) => s.id === "review"));
});

test("the action: composite, setup-go without cache, every with-input declared", () => {
  assert.equal(action.runs.using, "composite");
  const setupGo = action.runs.steps.find((s) => s.uses?.startsWith("actions/setup-go@"))!;
  assert.equal(setupGo.with?.cache, false);
  assert.equal(setupGo.if, "inputs.command == 'prepare'");
  const declared = new Set(Object.keys(action.inputs));
  for (const [job, s] of allSteps()) {
    if (!s.uses || !ACTION.test(s.uses)) continue;
    for (const k of Object.keys(s.with ?? {})) assert.ok(declared.has(k), `${job}: undeclared action input ${k}`);
  }
  for (const s of action.runs.steps) {
    for (const v of Object.values(s.env ?? {})) {
      const m = /inputs\.([a-z-]+)/.exec(v);
      if (m) assert.ok(declared.has(m[1]!), `env uses undeclared input ${m[1]}`);
    }
  }
});

test("the image: pinned base by digest, pinned checksummed tools, npm ci --ignore-scripts, PI_OFFLINE", () => {
  const docker = read("action/Dockerfile");
  const froms = [...docker.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]!);
  assert.ok(froms.length > 0);
  for (const f of froms) assert.match(f, /^node:\d+\.\d+\.\d+-[a-z]+-slim@sha256:[0-9a-f]{64}$/);
  assert.doesNotMatch(docker, /^#\s*syntax=/m);
  const instructions = docker.replace(/^#.*$/gm, "");
  assert.doesNotMatch(instructions, /apt-get|curl|wget/);
  assert.match(docker, /npm ci --ignore-scripts/);
  assert.match(docker, /PI_OFFLINE=1/);
  const tools = JSON.parse(read("action/tools.json")) as { tools: Array<{ name: string; version: string; assets: Record<string, { url: string; sha256: string; member: string }> }> };
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), ["fd", "gh", "rg"]);
  for (const t of tools.tools) {
    assert.deepEqual(Object.keys(t.assets).sort(), ["arm64", "x64"]);
    for (const a of Object.values(t.assets)) {
      assert.match(a.sha256, /^[0-9a-f]{64}$/);
      assert.match(a.url, /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+\.tar\.gz$/);
      assert.ok(a.url.includes(t.version), `${t.name} url names the pinned version`);
      assert.ok(a.member.endsWith(`/${t.name}`));
    }
  }
});

test("shell scripts parse", () => {
  for (const f of ["action/prepare.sh", "action/run.sh"]) execFileSync("bash", ["-n", join(ROOT, f)]);
});
