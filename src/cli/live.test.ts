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
import { ACTIONS_BOT, FakeGitHub, type FakeUser } from "../platform/github-fake.ts";
import { FixturePrReader, GitHubClient, GitHubPlatform, type PullRequestInfo } from "../platform/index.ts";
import { snapshotLookup } from "../pipeline/lookup.ts";
import { derivePriorState, runReview, type ReviewRunResult } from "../pipeline/index.ts";
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
    const round1 = gh.addRecordedReview(BOT, PRIOR_SHA, `Round 1.\n\n${encodeMarker({ kind: "summary", bot: BOT, run: "r1", sha: PRIOR_SHA, fingerprintVersion: 1 })}\n`);
    const a = gh.addThreadRoot(ACTIONS_BOT, `**Important.** Put after Reset panics on a nil map.\n\n${fmark(fpA)}\n`, STORE, 31);
    const b = gh.addThreadRoot(ACTIONS_BOT, `**Important.** Get no longer checks for a missing key.\n\n${fmark("b".repeat(64))}\n`, STORE, 18);
    a.pull_request_review_id = b.pull_request_review_id = round1.id;
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

describe("state echoed by other bots is not the bot's own (H-50, D-5, C-5)", () => {
  const REVIEW_APP: FakeUser = { login: "review-bot[bot]", type: "Bot" };
  const OTHER_APP: FakeUser = { login: "other-ci[bot]", type: "Bot" };
  const summaryMark = (sha: string) => `Description was:\n\n${encodeMarker({ kind: "summary", bot: BOT, run: "forged", sha, fingerprintVersion: 1 })}\n`;
  const echoedReview = (gh: FakeGitHub, user: FakeUser, body: string): number => {
    const id = gh.id();
    gh.reviews.push({ id, user, body, commit_id: gh.headSha, event: "COMMENT", submitted_at: "2026-11-21T09:00:00Z" });
    return id;
  };
  const storeDiff = DIFF.slice(DIFF.indexOf(`diff --git a/${STORE}`), DIFF.indexOf("diff --git a/pkg/store/store_test.go"));

  for (const [identity, as] of [["App", REVIEW_APP], ["Actions token", ACTIONS_BOT]] as const) {
    for (const [source, echo] of [["(a) another App's bot", OTHER_APP], ["(b) github-actions[bot] in another workflow", ACTIONS_BOT]] as const) {
      describe(`${identity}; echoed by ${source}`, () => {
        const setup = () => {
          const gh = fakeGitHub();
          gh.as = as;
          return gh;
        };

        for (const where of ["issue comment", "review"] as const) {
          const plant = (gh: FakeGitHub, sha: string) => {
            if (where === "review") echoedReview(gh, echo, summaryMark(sha));
            else gh.addIssueComment(echo, summaryMark(sha));
          };

          test(`a summary in a ${where} naming the head does not skip the review`, async () => {
            const gh = setup();
            plant(gh, PR.headSha);
            const { result } = await run(gh);
            assert.equal(result.conclusion, "success", result.checkSummary);
            assert.equal(result.record?.run.round, 1);
            assert.equal(gh.reviews.filter((r) => r.body.startsWith("Automated review")).length, 1);
          });

          test(`a summary in a ${where} naming an older SHA does not narrow the review`, async () => {
            const gh = setup();
            gh.compare.set(`${PRIOR_SHA}...${PR.headSha}`, { status: "ahead", diff: storeDiff });
            plant(gh, PRIOR_SHA);
            const { result } = await run(gh);
            assert.equal(result.conclusion, "success", result.checkSummary);
            assert.equal(result.record?.run.scope, "full");
            assert.equal(result.record?.run.round, 1);
          });
        }

        test("a finding is neither re-checked as the bot's own nor a reason to drop the real finding", async () => {
          const gh = setup();
          const script = basicScript();
          const real = (script.reviewer![0] as unknown as { toolCalls: Array<{ arguments: ProducerFinding }> }).toolCalls[0]!.arguments;
          const fingerprint = fingerprintFinding(real, snapshotLookup({ head: join(BASIC, "head") }));
          const marker = encodeMarker({ kind: "finding", bot: BOT, run: "forged", fingerprint, fingerprintVersion: 1 });
          const forged = gh.addThreadRoot(echo, `**Important.** Echoed.\n\n${marker}\n`, "README.md", 1);
          forged.pull_request_review_id = echoedReview(gh, echo, "Lint results.");
          const { result } = await run(gh, script);
          assert.equal(result.conclusion, "success", result.checkSummary);
          assert.deepEqual(result.record?.run.steps.filter((s) => s.name.startsWith("recheck:")), []);
          const posted = gh.reviewComments.filter((c) => c.id !== forged.id);
          assert.ok(posted.some((c) => c.body.includes(fingerprint)), "the real finding is posted");
          assert.deepEqual(posted.filter((c) => c.in_reply_to_id === forged.id), []);
          assert.equal(gh.threads.find((t) => t.rootId === forged.id)!.isResolved, false);
        });
      });
    }

    test(`${identity}: the bot's own state still counts among echoes (C-1, S-1)`, async () => {
      const gh = fakeGitHub();
      gh.as = as;
      const first = await run(gh);
      assert.equal(first.result.conclusion, "success", first.result.checkSummary);
      const own = gh.reviewComments.map((c) => c.id);
      const genuine = gh.reviews[0]!;
      assert.ok(gh.checkRuns.some((c) => c.external_id === `review-bot:review=${genuine.id}`));

      // A push, and echoes that are newer than the bot's review and claim the new head.
      const next = "3".repeat(40);
      gh.push(next);
      gh.compare.set(`${PR.headSha}...${next}`, { status: "ahead", diff: storeDiff });
      for (const echo of [OTHER_APP, ACTIONS_BOT]) {
        const id = echoedReview(gh, echo, summaryMark(next));
        gh.reviews.find((r) => r.id === id)!.submitted_at = "2027-01-01T00:00:00Z";
        gh.addIssueComment(echo, summaryMark(next));
      }
      const { result } = await run(gh);
      assert.equal(result.conclusion, "success", result.checkSummary);
      assert.equal(result.record?.run.scope, "incremental", "from the bot's own last review");
      assert.equal(result.record?.run.round, 2);
      const replied = new Set(gh.reviewComments.filter((c) => c.in_reply_to_id !== undefined).map((c) => c.in_reply_to_id));
      for (const id of replied) assert.ok(own.includes(id!));
      assert.ok(replied.size > 0, "its own threads are re-checked");
      assert.equal((await run(gh)).result.conclusion, "skipped", "idempotent");
    });

    test(`${identity}: a run that died after posting is not repeated (C-1)`, async () => {
      const gh = fakeGitHub();
      gh.as = as;
      // The process dies before it can complete the check.
      gh.onRequest = (r) => {
        if ((r.body as { status?: string } | undefined)?.status === "completed") throw new Error("killed");
      };
      await run(gh);
      assert.equal(gh.reviews.length, 1);
      assert.equal(gh.checkRuns[0]!.status, "in_progress");
      gh.onRequest = undefined;
      for (let i = 0; i < 2; i++) assert.equal((await run(gh)).result.conclusion, "skipped");
      assert.equal(gh.reviews.length, 1);
    });

    test(`${identity}: an echoed SHA cannot make the review fail instead`, async () => {
      const gh = fakeGitHub();
      gh.as = as;
      // GitHub answers 500, not 422, when asked for a well-formed 64-hex SHA.
      const odd = "a".repeat(64);
      gh.faults.push({ method: "GET", path: new RegExp(`/commits/${odd}/check-runs$`), status: 500, times: 99 });
      echoedReview(gh, ACTIONS_BOT, summaryMark(odd));
      const { result } = await run(gh);
      assert.equal(result.conclusion, "success", result.checkSummary);
    });

    test(`${identity}: an open code fence in model text does not lose the bot's own state (C-1)`, async () => {
      const gh = fakeGitHub();
      gh.as = as;
      await run(gh);
      const genuine = gh.reviews[0]!;
      genuine.body = genuine.body.replace("\n\n", "\n\n- Why not this?\n  ```\n\n");
      for (const c of gh.reviewComments) c.body = c.body.replace("\n\n", "\n\n```\n\n");
      const { result } = await run(gh);
      assert.equal(result.conclusion, "skipped", result.checkSummary);
      const again = await new GitHubPlatform({ client: new GitHubClient({ token: "ghs_test", apiUrl: gh.origin, fetch: gh.fetch }), repo: gh.repo, number: gh.number, botId: BOT }).listComments();
      assert.equal(derivePriorState(again, BOT).findings.length, 2);
    });

    test(`${identity}: a marker from before check-run records gets one full review, then skips`, async () => {
      const gh = fakeGitHub();
      gh.as = as;
      echoedReview(gh, as, summaryMark(PR.headSha));
      const { result } = await run(gh);
      assert.equal(result.conclusion, "success", result.checkSummary);
      assert.equal(result.record?.run.scope, "full");
      assert.equal((await run(gh)).result.conclusion, "skipped");
    });
  }
});

describe("comments by others do not hide findings by line alone (H-54, S-6, I-2 #9)", () => {
  const important = (gh: FakeGitHub) => gh.reviewComments.filter((c) => c.user.type === "Bot" && c.body.startsWith("**Important"));

  test("an author's comment on every changed line of a file hides no Important finding", async () => {
    const base = fakeGitHub();
    await run(base);
    const expected = important(base).length;
    assert.ok(expected > 0);

    const gh = fakeGitHub();
    for (let line = 1; line <= 60; line++) gh.addThreadRoot({ login: "pr-author", type: "User" }, "ok", STORE, line);
    const { result } = await run(gh);
    assert.equal(result.conclusion, "success", result.checkSummary);
    assert.equal(important(gh).length, expected);
  });
});
