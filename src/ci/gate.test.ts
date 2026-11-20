/** Authorization rules of the gate job (C-4, Q-10). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CI_WAIT } from "./ci-wait.ts";
import { decide, type GateConfig, type GateEvent, gateEventFrom, type GateFacts, resolveGateConfig, runGate } from "./gate.ts";
import { Github, type PullSummary } from "./github.ts";
import { fakeGithub, type FakeRepo, SHA_A, SHA_B, SHA_C } from "./testing.ts";

const LABEL = "ai-review/approved";
const config: GateConfig = { name: "main", label: LABEL, lifetime: "per-push", ci: DEFAULT_CI_WAIT };

function pr(over: Partial<PullSummary> = {}): PullSummary {
  return { number: 7, state: "open", draft: false, author: { login: "outsider", type: "User" }, labels: [], headSha: SHA_A, baseSha: SHA_B, baseRef: "main", ...over };
}

function ev(action: string, over: Partial<GateEvent> = {}): GateEvent {
  return { name: "pull_request_target", action, sender: "someone", prNumber: 7, headSha: SHA_A, ...over };
}

function facts(over: Partial<GateFacts> = {}): GateFacts {
  return { pr: pr(), authorIsMaintainer: false, ...over };
}

test("maintainers' PRs are reviewed on open and every push", () => {
  for (const action of ["opened", "reopened", "ready_for_review", "synchronize"]) {
    const d = decide(ev(action), config, facts({ authorIsMaintainer: true }));
    assert.equal(d.kind, "review", action);
    assert.equal(d.kind === "review" && d.via, "maintainer");
  }
});

test("an outsider's PR without the label is skipped, label untouched", () => {
  for (const action of ["opened", "synchronize", "ready_for_review"]) {
    const d = decide(ev(action), config, facts());
    assert.deepEqual(d.kind, "skip");
    assert.equal(d.kind === "skip" && d.removeLabel, false);
    assert.match(d.reason, /does not have write access/);
  }
});

test("labeled by a maintainer at the current head → review", () => {
  const d = decide(ev("labeled", { label: LABEL, sender: "maint" }), config, facts({ senderIsMaintainer: true }));
  assert.equal(d.kind, "review");
  assert.equal(d.kind === "review" && d.via, "label");
});

test("labeled by someone without write access (e.g. triage) → skipped and the label removed", () => {
  const d = decide(ev("labeled", { label: LABEL, sender: "triager" }), config, facts({ senderIsMaintainer: false }));
  assert.equal(d.kind, "skip");
  assert.equal(d.kind === "skip" && d.removeLabel, true);
});

test("labeled after the head moved → ignored; the push's run decides", () => {
  const d = decide(ev("labeled", { label: LABEL, headSha: SHA_C }), config, facts({ senderIsMaintainer: true }));
  assert.equal(d.kind, "ignore");
});

test("unrelated labels, maintainer PRs getting the label, closed PRs and other actions are ignored", () => {
  assert.equal(decide(ev("labeled", { label: "bug" }), config, facts({ senderIsMaintainer: true })).kind, "ignore");
  assert.equal(decide(ev("labeled", { label: LABEL }), config, facts({ authorIsMaintainer: true, senderIsMaintainer: true })).kind, "ignore");
  assert.equal(decide(ev("opened"), config, facts({ pr: pr({ state: "closed" }), authorIsMaintainer: true })).kind, "ignore");
  assert.equal(decide(ev("edited"), config, facts({ authorIsMaintainer: true })).kind, "ignore");
  assert.equal(decide({ ...ev("opened"), name: "pull_request" }, config, facts({ authorIsMaintainer: true })).kind, "ignore");
});

test("per-push: a push or reopen after approval revokes the label", () => {
  const f = facts({ pr: pr({ labels: [LABEL] }), labelApplier: { login: "maint", isMaintainer: true } });
  for (const action of ["synchronize", "reopened"]) {
    const d = decide(ev(action), config, f);
    assert.equal(d.kind, "skip", action);
    assert.equal(d.kind === "skip" && d.removeLabel, true);
    assert.match(d.reason, /label was removed/);
  }
  // Marking ready for review is not a push: the approval still holds.
  assert.equal(decide(ev("ready_for_review"), config, f).kind, "review");
});

test("per-pr: the label keeps authorizing pushes", () => {
  const f = facts({ pr: pr({ labels: [LABEL] }), labelApplier: { login: "maint", isMaintainer: true } });
  const d = decide(ev("synchronize"), { ...config, lifetime: "per-pr" }, f);
  assert.equal(d.kind, "review");
});

test("a label present but applied by someone without write access does not count", () => {
  for (const labelApplier of [undefined, { login: "triager", isMaintainer: false }]) {
    const d = decide(ev("ready_for_review"), { ...config, lifetime: "per-pr" }, facts({ pr: pr({ labels: [LABEL] }), ...(labelApplier ? { labelApplier } : {}) }));
    assert.equal(d.kind, "skip");
    assert.equal(d.kind === "skip" && d.removeLabel, true);
  }
});

test("manual dispatch: reviewed when the dispatcher has write access", () => {
  const dispatch: GateEvent = { name: "workflow_dispatch", sender: "maint", prNumber: 7 };
  assert.equal(decide(dispatch, config, facts({ senderIsMaintainer: true })).kind, "review");
  assert.equal(decide(dispatch, config, facts({ senderIsMaintainer: false })).kind, "ignore");
});

test("the base branch's review-bot.yaml overrides label and lifetime; a broken one forces per-push", () => {
  const warnings: string[] = [];
  const warn = (l: string) => void warnings.push(l);
  assert.deepEqual(resolveGateConfig(config, undefined, warn), config);
  assert.deepEqual(resolveGateConfig({ ...config, lifetime: "per-pr" }, "authorization:\n  label: bot-ok\n", warn), { name: "main", label: "bot-ok", lifetime: "per-pr", ci: DEFAULT_CI_WAIT });
  assert.deepEqual(resolveGateConfig(config, "authorization:\n  lifetime: per-pr\n", warn), { ...config, lifetime: "per-pr" });
  assert.deepEqual(resolveGateConfig({ ...config, lifetime: "per-pr" }, "authorization: [nope\n", warn), config);
  assert.equal(warnings.length, 1);
});

test("event payloads: pull_request_target and workflow_dispatch", () => {
  const e = gateEventFrom("pull_request_target", {
    action: "labeled",
    label: { name: LABEL },
    sender: { login: "maint" },
    pull_request: { number: 12, head: { sha: SHA_A } },
  });
  assert.deepEqual(e, { name: "pull_request_target", action: "labeled", label: LABEL, sender: "maint", prNumber: 12, headSha: SHA_A });
  assert.equal(gateEventFrom("workflow_dispatch", { inputs: { pr: "34" }, sender: { login: "maint" } }).prNumber, 34);
  assert.equal(gateEventFrom("workflow_dispatch", { inputs: {} }, 5).prNumber, 5);
  assert.throws(() => gateEventFrom("workflow_dispatch", { inputs: { pr: "x" } }));
});

function repo(over: Partial<FakeRepo> = {}): FakeRepo {
  return {
    pulls: { 7: { number: 7, user: { login: "outsider" }, labels: [], head: SHA_A, base: SHA_B } },
    roles: { maint: "maintain", admin: "admin", writer: "write", triager: "triage", reader: "read" },
    ...over,
  };
}

test("runGate: a maintainer (maintain role) author is reviewed, no check is written", async () => {
  const r = repo();
  r.pulls[7]!.user.login = "maint";
  const gh = fakeGithub(r);
  const res = await runGate(new Github({ token: "t", repo: "o/r", fetch: gh.fetch }), ev("opened"), config, () => {});
  assert.equal(res.decision.kind, "review");
  assert.equal(res.checkCompleted, false);
  assert.ok(!gh.calls.some((c) => c.method !== "GET"));
});

test("runGate: an outsider without the label gets a skipped check on the head SHA", async () => {
  const r = repo();
  const gh = fakeGithub(r);
  const res = await runGate(new Github({ token: "t", repo: "o/r", fetch: gh.fetch }), ev("opened"), config, () => {});
  assert.equal(res.decision.kind, "skip");
  assert.equal(res.checkCompleted, true);
  const post = gh.calls.find((c) => c.method === "POST");
  assert.equal(post?.path, "/check-runs");
  const body = post?.body as { name: string; head_sha: string; conclusion: string; status: string };
  assert.deepEqual([body.name, body.head_sha, body.status, body.conclusion], ["ai-review/main", SHA_A, "completed", "skipped"]);
});

test("runGate: a user unknown to the permissions API (404) is not a maintainer", async () => {
  const r = repo();
  r.pulls[7]!.user = { login: "dependabot[bot]", type: "Bot" };
  const gh = fakeGithub(r);
  const res = await runGate(new Github({ token: "t", repo: "o/r", fetch: gh.fetch }), ev("opened"), config, () => {});
  assert.equal(res.decision.kind, "skip");
  assert.ok(gh.calls.some((c) => c.path === "/collaborators/dependabot%5Bbot%5D/permission"));
});

test("runGate: the label's latest applier is found across event pages and checked", async () => {
  const r = repo({
    events: {
      7: [
        ...Array.from({ length: 5 }, () => ({ event: "labeled", label: "bug", actor: "reader" })),
        { event: "labeled", label: LABEL, actor: "triager" },
        { event: "unlabeled", label: LABEL, actor: "maint" },
        { event: "labeled", label: LABEL, actor: "writer" },
      ],
    },
  });
  r.pulls[7]!.labels = [LABEL];
  const gh = fakeGithub(r, 3);
  const res = await runGate(new Github({ token: "t", repo: "o/r", apiUrl: "https://api.example", fetch: gh.fetch }), ev("ready_for_review"), config, () => {});
  assert.equal(res.decision.kind, "review");
  assert.equal(res.decision.kind === "review" && res.decision.reason, `"${LABEL}" applied by writer`);
  assert.equal(gh.calls.filter((c) => c.path.startsWith("/issues/7/events")).length, 3);
});

test("runGate: label and lifetime come from .review/review-bot.yaml at the base SHA", async () => {
  const r = repo({ files: { [`.review/review-bot.yaml@${SHA_B}`]: "authorization:\n  label: bot-ok\n  lifetime: per-pr\n" }, events: { 7: [{ event: "labeled", label: "bot-ok", actor: "admin" }] } });
  r.pulls[7]!.labels = ["bot-ok"];
  const gh = fakeGithub(r);
  const res = await runGate(new Github({ token: "t", repo: "o/r", fetch: gh.fetch }), ev("synchronize"), config, () => {});
  assert.deepEqual(res.config, { name: "main", label: "bot-ok", lifetime: "per-pr", ci: DEFAULT_CI_WAIT });
  assert.equal(res.decision.kind, "review");
});

test("the token is sent only to the API host", async () => {
  const gh = fakeGithub(repo());
  const client = new Github({ token: "secret-token", repo: "o/r", fetch: gh.fetch });
  await client.getPull(7);
  assert.equal(gh.calls[0]?.auth, "Bearer secret-token");
  const evil: FakeRepo = repo({ events: { 7: [{ event: "labeled", label: LABEL, actor: "a" }, { event: "labeled", label: LABEL, actor: "b" }] } });
  const bad = fakeGithub(evil, 1);
  const redirecting: typeof bad.fetch = async (url, init) => {
    const res = await bad.fetch(url, init);
    return { ...res, headers: { get: (n: string) => (n.toLowerCase() === "link" ? '<https://evil.example/x>; rel="next"' : res.headers.get(n)) }, text: res.text };
  };
  await assert.rejects(new Github({ token: "secret-token", repo: "o/r", fetch: redirecting }).listLabelEvents(7), (e: Error) => {
    assert.match(e.message, /refusing to send the token to evil\.example/);
    assert.doesNotMatch(e.message, /secret-token/);
    return true;
  });
});
