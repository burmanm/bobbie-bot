/**
 * The pipeline driving the live GitHub platform (R-2) against an in-memory
 * GitHub behind a fake fetch, on the `basic` fixture PR with pi's scripted
 * provider: no network, no token, no key (AGENTS.md).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { createPiSdkAgentStep, createScriptedProvider, type Script } from "../agent/index.ts";
import { encodeMarker, fingerprintFinding, type ProducerFinding } from "../core/index.ts";
import { ACTIONS_BOT, FakeGitHub } from "../platform/github-fake.ts";
import { FixturePrReader, GitHubClient, GitHubPlatform, type PullRequestInfo } from "../platform/index.ts";
import { snapshotLookup } from "../pipeline/lookup.ts";
import { runReview, type ReviewRunResult } from "../pipeline/index.ts";
import { main } from "./main.ts";

const BASIC = join(dirname(fileURLToPath(import.meta.url)), "..", "pipeline", "fixtures", "prs", "basic");
const PR = JSON.parse(readFileSync(join(BASIC, "pr.json"), "utf8")) as PullRequestInfo;
const DIFF = readFileSync(join(BASIC, "pr.diff"), "utf8");
const PRIOR_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const STORE = "pkg/store/store.go";
const BOT = "ai-review/main";

const work = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-live-")));
after(() => rmSync(work, { recursive: true, force: true }));

const basicScript = (): Script => JSON.parse(readFileSync(join(BASIC, "script.json"), "utf8")) as Script;

function fakeGitHub(): FakeGitHub {
  return new FakeGitHub({ repo: PR.repo, number: PR.number, headSha: PR.headSha, baseSha: PR.baseSha, diff: DIFF });
}

async function run(gh: FakeGitHub, script: Script = basicScript()): Promise<{ result: ReviewRunResult; platform: GitHubPlatform; logs: string[] }> {
  const logs: string[] = [];
  const client = new GitHubClient({ token: "ghs_test", apiUrl: gh.origin, fetch: gh.fetch, sleep: async () => {}, retry: { maxAttempts: 2 } });
  const platform = new GitHubPlatform({ client, repo: gh.repo, number: gh.number, botId: BOT, log: (l) => logs.push(l) });
  const scripted = createScriptedProvider(script);
  const result = await runReview({
    platform,
    snapshots: new FixturePrReader(BASIC).snapshots(),
    agentStep: createPiSdkAgentStep({ providers: [scripted.provider], retry: { enabled: false }, abortGraceMs: 2_000 }),
    inputs: { models: { reviewer: "scripted/reviewer", verifier: "scripted/verifier" } },
    runsDir: join(work, "runs"),
    log: (l) => logs.push(l),
  });
  return { result, platform, logs };
}

describe("live run end to end", () => {
  test("posts one COMMENT review, completes the check; the next run on the same head reads its own marker back and skips (C-1)", async () => {
    const gh = fakeGitHub();
    const { result, logs } = await run(gh);
    assert.equal(result.conclusion, "success", `${result.checkSummary}\n${logs.join("\n")}`);
    assert.equal(gh.reviews.length, 1);
    assert.equal(gh.reviews[0]!.event, "COMMENT");
    assert.equal(gh.reviews[0]!.commit_id, PR.headSha);
    assert.equal(gh.reviewComments.length, 2);
    assert.equal(gh.checkRuns.length, 1);
    assert.deepEqual([gh.checkRuns[0]!.name, gh.checkRuns[0]!.head_sha, gh.checkRuns[0]!.status, gh.checkRuns[0]!.conclusion], [BOT, PR.headSha, "completed", "success"]);
    assert.deepEqual(result.record?.run.result.publishedCommentIds, [String(gh.reviews[0]!.id), ...gh.reviewComments.map((c) => String(c.id))]);

    const again = await run(gh);
    assert.equal(again.result.conclusion, "skipped", again.result.checkSummary);
    assert.match(again.result.checkSummary, /already reviewed/);
    assert.equal(gh.reviews.length, 1, "nothing posted twice");
    assert.equal(gh.checkRuns.length, 2);
    assert.equal(gh.checkRuns[1]!.conclusion, "skipped");
  });

  test("round 2: replies on own threads and resolves only the verified-fixed one (S-7, Q-9)", async () => {
    const gh = fakeGitHub();
    const storePart = DIFF.slice(DIFF.indexOf(`diff --git a/${STORE}`), DIFF.indexOf("diff --git a/pkg/store/store_test.go"));
    gh.compare.set(`${PRIOR_SHA}...${PR.headSha}`, { status: "ahead", diff: storePart });
    const script = basicScript();
    const putAfterReset = (script.reviewer![0] as unknown as { toolCalls: Array<{ arguments: ProducerFinding }> }).toolCalls[0]!.arguments;
    const fpA = fingerprintFinding(putAfterReset, snapshotLookup({ head: join(BASIC, "head") }));
    const fmark = (fp: string) => encodeMarker({ kind: "finding", bot: BOT, run: "r1", fingerprint: fp, fingerprintVersion: 1 });
    gh.reviews.push({
      id: 900,
      user: ACTIONS_BOT,
      body: `Round 1.\n\n${encodeMarker({ kind: "summary", bot: BOT, run: "r1", sha: PRIOR_SHA, fingerprintVersion: 1 })}\n`,
      commit_id: PRIOR_SHA,
      event: "COMMENT",
      submitted_at: "2026-11-17T09:00:00Z",
    });
    const a = gh.addThreadRoot(ACTIONS_BOT, `**Important.** Put after Reset panics on a nil map.\n\n${fmark(fpA)}\n`, STORE, 31);
    const b = gh.addThreadRoot(ACTIONS_BOT, `**Important.** Get no longer checks for a missing key.\n\n${fmark("b".repeat(64))}\n`, STORE, 18);
    script.verifier = [
      basicScript().verifier![2]!,
      { text: "Done." },
      {
        toolCalls: [
          {
            name: "submit_recheck",
            arguments: {
              status: "fixed",
              detail: "Get checks `ok` again before returning the value.",
              evidence: [{ root: "head", path: STORE, startLine: 18, endLine: 18, quote: "if !ok {" }],
            },
          },
        ],
      },
      { text: "Done." },
    ];
    const { result, logs } = await run(gh, script);
    assert.equal(result.conclusion, "success", `${result.checkSummary}\n${logs.join("\n")}`);
    const replies = gh.reviewComments.filter((c) => c.in_reply_to_id !== undefined);
    assert.deepEqual(
      replies.map((r) => [r.in_reply_to_id, r.body.split(".**")[0]]),
      [
        [a.id, "**Still open at `89abcde`"],
        [b.id, "**Verified fixed at `89abcde`"],
      ],
    );
    assert.deepEqual(gh.threads.filter((t) => t.isResolved).map((t) => t.rootId), [b.id]);
  });

  test("a failed review post: failure comment posted, then updated in place on the next push; check neutral (S-9)", async () => {
    const gh = fakeGitHub();
    gh.faults.push({ method: "POST", path: /\/reviews$/, status: 403, body: { message: "Resource not accessible by integration" }, times: 2 });
    const first = await run(gh);
    assert.equal(first.result.conclusion, "neutral");
    assert.match(first.result.checkSummary, /Review could not complete: GitHub POST .*reviews: 403 Resource not accessible by integration/);
    assert.equal(gh.issueComments.length, 1);
    const id = gh.issueComments[0]!.id;
    assert.match(gh.issueComments[0]!.body, /^Automated review could not complete for `89abcde`/);
    assert.equal(gh.checkRuns[0]!.conclusion, "neutral");

    gh.push("1".repeat(40));
    const second = await run(gh);
    assert.equal(second.result.conclusion, "neutral");
    assert.equal(gh.issueComments.length, 1, "not repeated per push");
    assert.equal(gh.issueComments[0]!.id, id);
    assert.match(gh.issueComments[0]!.body, /`1111111`/);
    assert.equal(gh.checkRuns.length, 2);
  });

  test("a newer push during the run: nothing posted to the old head, check neutral 'superseded' (S-9)", async () => {
    const gh = fakeGitHub();
    gh.onRequest = (r) => {
      if (r.method === "GET" && r.path.endsWith(`/pulls/${PR.number}/reviews`) && gh.headSha === PR.headSha) gh.push("2".repeat(40));
    };
    const { result } = await run(gh);
    assert.equal(result.conclusion, "neutral");
    assert.match(result.checkSummary, /superseded by a newer push: the head moved from 89abcde to 2222222/);
    assert.equal(gh.reviews.length, 0);
    assert.equal(gh.issueComments.length, 0);
    assert.deepEqual([gh.checkRuns[0]!.head_sha, gh.checkRuns[0]!.conclusion, gh.checkRuns[0]!.output?.title], [PR.headSha, "neutral", "Superseded by a newer push"]);
  });

  test("the CLI posts with GH_TOKEN and prints what it did; refuses a PAT and a fixture", async () => {
    const gh = fakeGitHub();
    const out = { stdout: "", stderr: "" };
    const io = { stdout: (s: string) => void (out.stdout += s), stderr: (s: string) => void (out.stderr += s) };
    const args = ["review", "--pr", `${PR.repo}#${PR.number}`, "--repo-dir", work, "--no-modcache", "--runs-dir", join(work, "runs"), "--quiet"];
    // A personal access token is a usage error, before anything is read.
    assert.equal(await main(args, io, { env: { GITHUB_TOKEN: "ghp_x" }, fetch: gh.fetch }), 2);
    assert.match(out.stderr, /personal access token/);
    assert.equal(await main(args, io, { env: {}, fetch: gh.fetch }), 2);
    assert.match(out.stderr, /neither GH_TOKEN nor GITHUB_TOKEN is set/);
    assert.equal(await main(["review", "--fixture", BASIC], io, { env: { GITHUB_TOKEN: "ghs_x" } }), 2);
    assert.match(out.stderr, /--fixture needs --dry-run/);
    assert.equal(gh.requests.length, 0);

    // Live with no model configured: the check opens and completes neutral (P-4); the snapshot is never needed.
    out.stdout = "";
    const env = { GH_TOKEN: "ghs_x", GITHUB_API_URL: gh.origin, GITHUB_SERVER_URL: "https://github.test", GITHUB_REPOSITORY: PR.repo, GITHUB_RUN_ID: "99" };
    const code = await main(args, io, { env, fetch: gh.fetch });
    assert.equal(code, 1, out.stderr);
    const report = JSON.parse(out.stdout) as { live: boolean; check_run: { conclusion: string } };
    assert.equal(report.live, true);
    assert.equal(report.check_run.conclusion, "neutral");
    assert.equal(gh.checkRuns[0]!.details_url, `https://github.test/${PR.repo}/actions/runs/99`);
    assert.ok(gh.requests.every((r) => r.authorization === "Bearer ghs_x" && r.url.startsWith(gh.origin)));
    assert.equal(gh.issueComments.length, 1, "configuration failure comment");
    assert.equal(gh.issueComments[0]!.user.login, ACTIONS_BOT.login);
  });
});
