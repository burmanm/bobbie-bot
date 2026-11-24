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
import { SAVED_SCRIPTS_FILE } from "../core/saved-scripts.ts";

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
  on: Record<string, { types?: string[]; workflows?: string[]; inputs?: Record<string, { required?: boolean; type?: string }> } | null | Array<{ cron: string }>> & {
    pull_request_target: { types: string[] };
    workflow_dispatch: { inputs: Record<string, { required?: boolean; type?: string }> };
    workflow_run: { types: string[]; workflows: string[] };
    schedule: Array<{ cron: string }>;
  };
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean | string };
  jobs: Record<string, Job>;
}

const wfText = read("workflows/review-bot.yml");
const wf = parse(wfText) as Workflow;
const action = parse(read("action/action.yml")) as { inputs: Record<string, unknown>; runs: { using: string; steps: Step[] } };
const ACTION = /^REVIEW_BOT_OWNER\/review-bot\/action@[0-9a-f]{40}$/;
const PINNED = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._/-]+)?@[0-9a-f]{40}$/;

const allSteps = (): Array<[string, Step]> => Object.entries(wf.jobs).flatMap(([j, job]) => job.steps.map((s) => [j, s] as [string, Step]));

test("triggers: pull_request_target with the C-2 actions, manual dispatch with a PR number, C-9 re-triggers", () => {
  assert.deepEqual(Object.keys(wf.on).sort(), ["pull_request_target", "schedule", "status", "workflow_dispatch", "workflow_run"]);
  assert.deepEqual(wf.on.pull_request_target.types, ["opened", "reopened", "ready_for_review", "synchronize", "labeled"]);
  assert.equal(wf.on.workflow_dispatch.inputs.pr?.required, true);
  assert.equal(wf.on.workflow_dispatch.inputs["ignore-ci"]?.type, "boolean");
  // C-9: workflow_run on completion, never on this workflow itself (no self-triggering chain).
  assert.deepEqual(wf.on.workflow_run.types, ["completed"]);
  assert.ok(wf.on.workflow_run.workflows.includes("!review-bot"));
  assert.match(wfText, /^name: review-bot$/m);
  assert.equal(wf.on.status, null);
  // Every 30 minutes (C-9 sweep).
  assert.deepEqual(wf.on.schedule.map((s) => s.cron), ["17,47 * * * *"]);
});

test("C-9: the gate skips pending statuses and CI runs that cannot be a PR head's; resume events need no PR in the payload", () => {
  const cond = wf.jobs.gate!.if!;
  assert.match(cond, /github\.event_name == 'status' && github\.event\.state != 'pending'/);
  assert.match(cond, /"pull_request", "pull_request_target", "push"\]'\), github\.event\.workflow_run\.event/);
  assert.match(cond, /github\.event_name == 'schedule'/);
  // Nothing from workflow_run / status payloads but the SHA is used anywhere in the file.
  for (const m of wfText.matchAll(/github\.event\.(workflow_run|sha|state|context|branches|commit)[\w.]*/g)) {
    assert.ok(["github.event.workflow_run.head_sha", "github.event.workflow_run.event", "github.event.sha", "github.event.state"].includes(m[0]), m[0]);
  }
  const gate = wf.jobs.gate!.steps.find((s) => s.id === "gate")!;
  for (const k of ["ci-require", "ci-on-failure", "ci-timeout", "ignore-ci"]) assert.ok(gate.with?.[k] !== undefined, k);
  const review = wf.jobs.review!.steps.find((s) => s.id === "review")!;
  assert.equal(review.with?.waiting, "${{ needs.gate.outputs.waiting }}");
});

test("no default token permissions; each job gets exactly its C-4 set", () => {
  assert.deepEqual(wf.permissions, {});
  assert.deepEqual(wf.jobs.gate!.permissions, { contents: "read", "pull-requests": "read", checks: "write", statuses: "read", actions: "read" });
  assert.deepEqual(wf.jobs["remove-label"]!.permissions, { "pull-requests": "write" });
  assert.deepEqual(wf.jobs.prepare!.permissions, { contents: "read" });
  assert.deepEqual(wf.jobs.review!.permissions, { "pull-requests": "write", checks: "write" });
  // F-7, C-4: the job that downloads packages gets no token permissions at all.
  assert.deepEqual(wf.jobs.setup!.permissions, {});
  assert.deepEqual(Object.keys(wf.jobs).sort(), ["gate", "prepare", "remove-label", "review", "setup"]);
});

test("concurrency per PR with cancel-in-progress (S-9); unrelated label events cancel nothing; C-9 events queue per SHA", () => {
  assert.equal(wf.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request_target' || github.event_name == 'workflow_dispatch' }}");
  assert.match(wf.concurrency.group, /github\.event\.pull_request\.number \|\| inputs\.pr/);
  assert.match(wf.concurrency.group, /review-bot-ignored-\{0\}', github\.run_id/);
  assert.match(wf.concurrency.group, /review-bot-\{0\}-sha-\{1\}'.*github\.event\.workflow_run\.head_sha \|\| github\.event\.sha/s);
  assert.match(wf.concurrency.group, /review-bot-\{0\}-sweep/);
});

test("private repositories (C-4): history permissions are opt-in, never granted by default", () => {
  assert.match(wfText, /^      # contents: read\n      # issues: read$/m);
  const app = wf.jobs.review!.steps.find((s) => s.uses?.startsWith("actions/create-github-app-token@"))!;
  assert.equal(app.with?.["permission-contents"], "${{ vars.REVIEW_BOT_HISTORY_READ == 'true' && 'read' || '' }}");
  assert.equal(app.with?.["permission-issues"], "${{ vars.REVIEW_BOT_HISTORY_READ == 'true' && 'read' || '' }}");
  assert.equal(wf.jobs.review!.steps.find((s) => s.id === "review")!.with?.["no-history"], "${{ vars.REVIEW_BOT_NO_HISTORY }}");
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

test("secrets: only the review job has the model key; prepare and setup hold nothing", () => {
  const secretsIn = (job: Job) => JSON.stringify(job).match(/secrets\.[A-Z_]+/g) ?? [];
  for (const name of ["prepare", "setup"]) {
    assert.deepEqual(secretsIn(wf.jobs[name]!), [], name);
    assert.ok(!JSON.stringify(wf.jobs[name]).includes("steps.app"), name);
  }
  // setup gets no GitHub token either (F-7, C-4).
  assert.ok(!/token/i.test(JSON.stringify(wf.jobs.setup)));
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
    else if (job === "setup") assert.equal(token, undefined);
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
  // scripts.json sits next to 08-record.json in runs/run-<id>/, so the same glob uploads it (A-6, F-7).
  assert.match(SAVED_SCRIPTS_FILE, /^[^/]+\.json$/);
  assert.equal(wf.jobs.review!.if, "${{ !cancelled() && needs.gate.outputs.review == 'true' }}");
  assert.ok(steps.indexOf(complete) > steps.findIndex((s) => s.id === "review"));
  // A check the gate completes itself leaves a record too (R-2 exit).
  const gateSteps = wf.jobs.gate!.steps;
  const gateRecord = gateSteps.find((s) => String(s.with?.name ?? "").startsWith("review-bot-record-"))!;
  assert.equal(gateRecord.if, "always()");
  assert.match(String(gateRecord.with?.path), /gate-out\/records\/\*\.json$/);
  assert.equal(gateRecord.with?.["if-no-files-found"], "ignore");
  assert.ok(gateSteps.indexOf(gateRecord) > gateSteps.findIndex((s) => s.id === "gate"));
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
  // The real node by absolute path, so SIGTERM reaches review-bot launch (F-3, S-9).
  assert.match(docker, /^ENTRYPOINT \["\/usr\/local\/bin\/node", "\/opt\/review-bot\/src\/cli\/main\.ts"\]$/m);
  // git (F-7 setup): pinned .debs from snapshot.debian.org with SHA-256, installed by dpkg from a bind mount.
  assert.match(docker, /fetch-debs\.mjs \/build\/debs\.json/);
  assert.match(docker, /--mount=type=bind,from=tools,source=\/build\/debs,target=\/debs/);
  const debs = JSON.parse(read("action/debs.json")) as { snapshot: string; debs: Record<string, Array<{ name: string; version: string; url: string; sha256: string }>> };
  assert.deepEqual(Object.keys(debs.debs).sort(), ["arm64", "x64"]);
  for (const list of Object.values(debs.debs)) {
    assert.ok(list.some((d) => d.name === "git"));
    for (const d of list) {
      assert.match(d.sha256, /^[0-9a-f]{64}$/);
      assert.ok(d.url.startsWith(`https://snapshot.debian.org/archive/debian`) && d.url.includes(`/${debs.snapshot}/pool/`), d.url);
      assert.match(d.url, /\.deb$/);
    }
    assert.equal(new Set(list.map((d) => d.name)).size, list.length);
  }
  // The same package set on both architectures.
  assert.deepEqual(debs.debs.x64!.map((d) => d.name), debs.debs.arm64!.map((d) => d.name));
  const ignore = read("action/Dockerfile.dockerignore");
  for (const f of ["action/debs.json", "action/fetch-debs.mjs"]) assert.match(ignore, new RegExp(`^!${f.replace(".", "\\.")}$`, "m"));
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
  for (const f of ["action/prepare.sh", "action/run.sh", "action/update-debs.sh"]) execFileSync("bash", ["-n", join(ROOT, f)]);
});

test("the image publish workflow (C-4): manual, default branch only, pinned, provenance and attestation", () => {
  const text = read(".github/workflows/action-image.yml");
  const pub = parse(text) as { on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, Job> };
  assert.deepEqual(Object.keys(pub.on), ["workflow_dispatch"]);
  assert.deepEqual(pub.permissions, {});
  const job = pub.jobs.publish!;
  assert.equal(job.if, "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)");
  assert.deepEqual(job.permissions, { contents: "read", packages: "write", "id-token": "write", attestations: "write" });
  for (const s of job.steps) {
    if (s.uses) assert.match(s.uses, PINNED, s.uses);
    assert.ok(s.run === undefined || !s.run.includes("${{"), String(s.name));
  }
  const build = job.steps.find((s) => s.uses?.startsWith("docker/build-push-action@"))!;
  assert.equal(build.with?.file, "action/Dockerfile");
  assert.equal(build.with?.provenance, "mode=max");
  assert.equal(build.with?.sbom, true);
  assert.equal(build.with?.["no-cache"], true);
  const attest = job.steps.find((s) => s.uses?.startsWith("actions/attest-build-provenance@"))!;
  assert.equal(attest.with?.["subject-digest"], "${{ steps.build.outputs.digest }}");
  assert.equal(job.steps.find((s) => s.uses?.startsWith("actions/checkout@"))!.with?.["persist-credentials"], false);
});

test("the agent directory (F-7, D-19): fetched by the gate, never from the PR, handed to the review job as an artifact", () => {
  const gate = wf.jobs.gate!.steps;
  const gateStep = gate.find((s) => s.id === "gate")!;
  assert.equal(gateStep.with?.["agent-dir"], "${{ vars.REVIEW_BOT_AGENT_DIR }}");
  assert.equal(gateStep.with?.["agent-dir-repo"], "${{ vars.REVIEW_BOT_AGENT_DIR_REPO }}");
  // Unset variables reach the action empty, so settings.json shows through.
  assert.equal(gateStep.with?.["auth-label"], "${{ vars.REVIEW_BOT_AUTH_LABEL }}");
  assert.equal(gateStep.with?.["auth-label-lifetime"], "${{ vars.REVIEW_BOT_AUTH_LABEL_LIFETIME }}");
  const upload = gate.find((s) => s.with?.name === "review-bot-agent-dir")!;
  assert.ok(gate.indexOf(upload) > gate.indexOf(gateStep));
  assert.match(String(upload.if), /vars\.REVIEW_BOT_AGENT_DIR != ''/);
  assert.match(String(upload.with?.path), /review-bot\/agent\/dir$/);

  // .npmrc is hidden, and upload-artifact skips hidden files by default.
  assert.equal(upload.with?.["include-hidden-files"], true);

  // The setup job installs its packages (F-7, C-4) and hands on an archive.
  const setupJob = wf.jobs.setup!;
  assert.equal(setupJob.needs, "gate");
  assert.equal(setupJob.if, "needs.gate.outputs.review == 'true' && vars.REVIEW_BOT_AGENT_DIR != ''");
  const fromGate = setupJob.steps.find((s) => s.with?.name === "review-bot-agent-dir")!;
  assert.ok(fromGate.uses?.startsWith("actions/download-artifact@"));
  assert.match(String(fromGate.with?.path), /review-bot\/agent\/dir$/);
  const install = setupJob.steps.find((s) => s.with?.command === "setup")!;
  assert.equal(install.with?.["agent-dir"], "${{ vars.REVIEW_BOT_AGENT_DIR }}");
  assert.deepEqual(Object.keys(install.with ?? {}).sort(), ["agent-dir", "command", "image"]);
  const handOn = setupJob.steps.find((s) => s.with?.name === "review-bot-agent-installed")!;
  assert.ok(handOn.uses?.startsWith("actions/upload-artifact@"));
  assert.match(String(handOn.with?.path), /review-bot\/agent-out\/agent-dir\.tar\.gz$/);
  assert.ok(setupJob.steps.indexOf(fromGate) < setupJob.steps.indexOf(install) && setupJob.steps.indexOf(install) < setupJob.steps.indexOf(handOn));

  // The review job takes the setup job's result, never the gate's copy, and downloads nothing else.
  assert.deepEqual(wf.jobs.review!.needs, ["gate", "prepare", "setup"]);
  const review = wf.jobs.review!.steps;
  assert.ok(!review.some((s) => s.with?.name === "review-bot-agent-dir"));
  const download = review.find((s) => s.with?.name === "review-bot-agent-installed")!;
  const reviewStep = review.find((s) => s.id === "review")!;
  assert.ok(download.uses?.startsWith("actions/download-artifact@"));
  assert.match(String(download.with?.path), /review-bot\/agent-in$/);
  assert.equal(download.if, "vars.REVIEW_BOT_AGENT_DIR != ''");
  assert.ok(review.indexOf(download) < review.indexOf(reviewStep));
  assert.equal(reviewStep.with?.["agent-dir"], "${{ vars.REVIEW_BOT_AGENT_DIR }}");
  assert.equal(reviewStep.with?.["agent-dir-repo"], undefined, "only the gate fetches");
  // The review job keeps its C-4 permissions: no contents read for this.
  assert.equal(wf.jobs.review!.permissions?.contents, undefined);
  assert.doesNotMatch(wfText, /actions\/checkout/);
});
