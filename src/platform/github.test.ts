/**
 * Live GitHub platform (R-2) against an in-memory GitHub behind a fake
 * fetch: no network, no token (AGENTS.md).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { encodeMarker } from "../core/index.ts";
import { completeCheckRun, findCheckRun } from "./github-checks.ts";
import { assertInstallationToken, GitHubClient, gitHubClientFromEnv, GraphQLError, RateLimitError } from "./github-client.ts";
import { ACTIONS_BOT, FakeGitHub, type FakeReviewComment, type FakeUser, HUMAN } from "./github-fake.ts";
import { attributeComments, hasFailureMarker } from "./github-markers.ts";
import { foldInlineComments, GitHubPlatform, SupersededError } from "./github.ts";
import type { PrComment, Publication, ReviewPayload } from "./types.ts";

const TOKEN = "ghs_faketoken0000";
const BOT = "ai-review/main";
const OTHER_APP: FakeUser = { login: "other-ci[bot]", type: "Bot" };

function fp(n: number): string {
  return n.toString(16).padStart(64, "0");
}
function findingBody(title: string, n: number, bot = BOT): string {
  return `**Important.** ${title}.\n\nDetails.\n\n${encodeMarker({ kind: "finding", bot, run: "r1", fingerprint: fp(n), fingerprintVersion: 1 })}\n`;
}
function summaryBody(gh: FakeGitHub, run = "r2"): string {
  return `Round 2.\n\n${encodeMarker({ kind: "summary", bot: BOT, run, sha: gh.headSha, fingerprintVersion: 1 })}\n`;
}

interface Setup {
  gh: FakeGitHub;
  client: GitHubClient;
  platform: GitHubPlatform;
  sleeps: number[];
  logs: string[];
}

/** A finding thread the bot posted with a review it recorded (D-5). */
function ownRoot(gh: FakeGitHub, body: string, path = "a.go", line = 3, resolved = false): FakeReviewComment {
  const earlier = gh.addRecordedReview(BOT, "9".repeat(40), summaryBody(gh, "r1").replace(gh.headSha, "9".repeat(40)));
  const root = gh.addThreadRoot(gh.as, body, path, line, resolved);
  root.pull_request_review_id = earlier.id;
  return root;
}

/** Without the reviews `ownRoot` seeded. */
const postedReviews = (gh: FakeGitHub) => gh.reviews.filter((r) => r.commit_id === gh.headSha);

function setup(gh = new FakeGitHub(), o: { maxAttempts?: number } = {}): Setup {
  const sleeps: number[] = [];
  const logs: string[] = [];
  const client = new GitHubClient({
    token: TOKEN,
    apiUrl: gh.origin,
    fetch: gh.fetch,
    sleep: async (ms) => void sleeps.push(ms),
    now: () => Date.UTC(2026, 10, 20),
    retry: { maxAttempts: o.maxAttempts ?? 4, baseDelayMs: 100 },
    log: (l) => logs.push(l),
  });
  const platform = new GitHubPlatform({ client, repo: gh.repo, number: gh.number, botId: BOT, log: (l) => logs.push(l), now: () => new Date(Date.UTC(2026, 10, 20)) });
  return { gh, client, platform, sleeps, logs };
}

function review(gh: FakeGitHub, comments: ReviewPayload["comments"] = []): ReviewPayload {
  return { commit_id: gh.headSha, event: "COMMENT", body: summaryBody(gh), comments };
}

describe("client: identity and token handling (C-5)", () => {
  test("refuses personal access tokens and user tokens; accepts installation tokens", () => {
    for (const t of ["ghp_x", "github_pat_x", "gho_x", "ghu_x", "ghr_x"]) assert.throws(() => assertInstallationToken(t), /accepts only the Actions GITHUB_TOKEN or a GitHub App installation token/);
    assert.throws(() => assertInstallationToken(" "), /empty/);
    assert.doesNotThrow(() => assertInstallationToken("ghs_abc"));
    assert.throws(() => gitHubClientFromEnv({}), /neither GH_TOKEN nor GITHUB_TOKEN is set/);
    // GH_TOKEN wins, as in gh; an empty one falls through.
    assert.throws(() => gitHubClientFromEnv({ GH_TOKEN: "ghp_user", GITHUB_TOKEN: "ghs_x" }), /personal access token/);
    assert.doesNotThrow(() => gitHubClientFromEnv({ GH_TOKEN: "ghs_app", GITHUB_TOKEN: "ghp_user" }));
    assert.doesNotThrow(() => gitHubClientFromEnv({ GH_TOKEN: "", GITHUB_TOKEN: "ghs_x" }));
    const c = gitHubClientFromEnv({ GITHUB_TOKEN: "ghs_x", GITHUB_API_URL: "https://ghe.example/api/v3" });
    assert.equal(c.apiUrl, "https://ghe.example/api/v3");
    assert.equal(c.graphqlUrl, "https://ghe.example/api/v3/graphql");
  });

  test("the token goes only to the API origin, and never into an error", async () => {
    const { gh, client } = setup();
    await client.get(`repos/${gh.repo}/pulls/${gh.number}`);
    assert.equal(gh.requests[0]!.authorization, `Bearer ${TOKEN}`);
    await assert.rejects(client.get("https://evil.example/x"), /refusing to send the token to another origin/);
    assert.equal(gh.requests.length, 1);
    gh.faults.push({ method: "GET", path: /pulls/, status: 401, body: { message: "Bad credentials" } });
    await assert.rejects(client.get(`repos/${gh.repo}/pulls/${gh.number}`), (e: Error) => !e.message.includes(TOKEN) && /401 Bad credentials/.test(e.message));
  });

  test("pagination follows Link headers", async () => {
    const gh = new FakeGitHub({ pageSize: 2 });
    for (let i = 0; i < 5; i++) gh.addIssueComment(HUMAN, `c${i}`);
    const { client } = setup(gh);
    const all = await client.paginate<{ body: string }>(`repos/${gh.repo}/issues/${gh.number}/comments`);
    assert.deepEqual(all.map((c) => c.body), ["c0", "c1", "c2", "c3", "c4"]);
    assert.equal(gh.requests.length, 3);
  });
});

describe("client: rate limits and transient errors (S-9)", () => {
  test("primary limit waits until the reset, then succeeds", async () => {
    const { gh, client, sleeps } = setup();
    const reset = Date.UTC(2026, 10, 20) / 1000 + 30;
    gh.faults.push({ method: "GET", path: /pulls/, status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }, body: { message: "API rate limit exceeded" } });
    await client.get(`repos/${gh.repo}/pulls/${gh.number}`);
    assert.deepEqual(sleeps, [31_000]);
  });

  test("a reset beyond the bound fails fast with RateLimitError", async () => {
    const { gh, client, sleeps } = setup();
    const reset = Date.UTC(2026, 10, 20) / 1000 + 3600;
    gh.faults.push({ method: "GET", path: /pulls/, status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } });
    await assert.rejects(client.get(`repos/${gh.repo}/pulls/${gh.number}`), RateLimitError);
    assert.deepEqual(sleeps, []);
  });

  test("429 honours retry-after; a secondary limit waits a minute; even for POST (refused requests took no effect)", async () => {
    const { gh, client, sleeps } = setup();
    gh.faults.push({ method: "POST", path: /issues\/7\/comments/, status: 429, headers: { "retry-after": "5" } });
    gh.faults.push({ method: "POST", path: /issues\/7\/comments/, status: 403, body: { message: "You have exceeded a secondary rate limit." } });
    await client.request("POST", `repos/${gh.repo}/issues/${gh.number}/comments`, { body: { body: "x" } });
    assert.deepEqual(sleeps, [5_000, 60_000]);
    assert.equal(gh.issueComments.length, 1);
  });

  test("transient 5xx and network errors on reads back off and retry, bounded", async () => {
    const { gh, client, sleeps } = setup(new FakeGitHub(), { maxAttempts: 3 });
    gh.faults.push({ method: "GET", path: /pulls/, status: 502 }, { method: "GET", path: /pulls/, status: 0, network: true });
    await client.get(`repos/${gh.repo}/pulls/${gh.number}`);
    assert.deepEqual(sleeps, [100, 200]);
    gh.faults.push({ method: "GET", path: /pulls/, status: 503, times: 3 });
    await assert.rejects(client.get(`repos/${gh.repo}/pulls/${gh.number}`), /503/);
  });

  test("a POST without a probe is not repeated after an ambiguous failure", async () => {
    const { gh, client } = setup();
    gh.faults.push({ method: "POST", path: /issues\/7\/comments/, status: 502, afterEffect: true });
    await assert.rejects(client.request("POST", `repos/${gh.repo}/issues/${gh.number}/comments`, { body: { body: "x" } }), /502/);
    assert.equal(gh.issueComments.length, 1);
  });

  test("GraphQL errors surface with their types; RATE_LIMITED waits and retries", async () => {
    const gh = new FakeGitHub({ canResolveThreads: false });
    const { client } = setup(gh);
    await assert.rejects(client.graphql("mutation($threadId:ID!){x}", { threadId: "T" }), (e: unknown) => e instanceof GraphQLError && e.types.includes("FORBIDDEN"));
    const sleeps: number[] = [];
    let calls = 0;
    const limited = new GitHubClient({
      token: TOKEN,
      apiUrl: gh.origin,
      sleep: async (ms) => void sleeps.push(ms),
      fetch: async () =>
        new Response(JSON.stringify(++calls === 1 ? { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] } : { data: { ok: true } }), { status: 200 }),
    });
    assert.deepEqual(await limited.graphql("query{ok}", {}), { ok: true });
    assert.deepEqual(sleeps, [60_000]);
  });
});

describe("publish (S-7)", () => {
  test("one COMMENT review with inline comments, replies on own threads, resolution only after Verified fixed", async () => {
    const { gh, platform } = setup();
    const own = ownRoot(gh, findingBody("Nil map", 1), "a.go", 3);
    const ownStillOpen = ownRoot(gh, findingBody("Leak", 2), "a.go", 9);
    const ownNoReply = ownRoot(gh, findingBody("Race", 3), "a.go", 12);
    // A human pasting the bot's marker, and another workflow under the same Actions login without a marker.
    const forged = gh.addThreadRoot(HUMAN, findingBody("Forged", 4), "a.go", 20);
    const otherWorkflow = gh.addThreadRoot(ACTIONS_BOT, "**Lint.** unused import", "a.go", 30);
    const otherBotId = gh.addThreadRoot(OTHER_APP, findingBody("Another reviewer", 5, "ai-review/security"), "a.go", 40);

    const pr = await platform.getPullRequest();
    await platform.startCheck(BOT, pr.headSha);
    const comments = await platform.listComments();
    assert.equal(comments.filter((c) => c.threadResolved === false).length, 6);

    const fixed = (id: number) => ({ in_reply_to: id, body: `**Verified fixed at \`${gh.headSha.slice(0, 7)}\`.** Guarded.\n` });
    const publication: Publication = {
      review: review(gh, [{ path: "a.go", line: 5, side: "RIGHT", body: findingBody("New", 9) }]),
      threadReplies: [
        fixed(own.id),
        { in_reply_to: ownStillOpen.id, body: "**Still open at `bbbbbbb`.** Not yet.\n" },
        fixed(forged.id),
        fixed(otherWorkflow.id),
        fixed(otherBotId.id),
      ],
      resolveThreads: [own, ownStillOpen, ownNoReply, forged, otherWorkflow, otherBotId].map((c) => ({ comment_id: c.id, reason: "verified fixed" })),
    };
    const result = await platform.publish(publication);

    assert.equal(postedReviews(gh).length, 1);
    assert.equal(postedReviews(gh)[0]!.event, "COMMENT");
    const inline = gh.reviewComments.filter((c) => c.pull_request_review_id === postedReviews(gh)[0]!.id);
    assert.equal(inline.length, 1);
    const replies = gh.reviewComments.filter((c) => c.in_reply_to_id !== undefined);
    assert.deepEqual(replies.map((c) => c.in_reply_to_id).sort(), [own.id, ownStillOpen.id].sort());
    assert.deepEqual(
      gh.threads.filter((t) => t.isResolved).map((t) => t.rootId),
      [own.id],
      "only the bot's own thread with a Verified fixed reply is resolved",
    );
    assert.deepEqual(result.commentIds, [String(postedReviews(gh)[0]!.id), String(inline[0]!.id), ...replies.map((r) => String(r.id))]);
    const w = (result.warnings ?? []).join("\n");
    assert.match(w, new RegExp(`reply to comment ${forged.id} not posted: not a thread of ai-review/main`));
    assert.match(w, new RegExp(`reply to comment ${otherWorkflow.id} not posted`));
    assert.match(w, new RegExp(`reply to comment ${otherBotId.id} not posted`));
    assert.match(w, new RegExp(`thread of comment ${ownStillOpen.id} not resolved: no "Verified fixed" reply`));
    assert.match(w, new RegExp(`thread of comment ${ownNoReply.id} not resolved`));
    const mutations = gh.writes().filter((r) => r.path === "/graphql");
    assert.equal(mutations.length, 1);
  });

  test("a refused thread resolution is a warning; the review stays published", async () => {
    const gh = new FakeGitHub({ canResolveThreads: false });
    const { platform } = setup(gh);
    const own = ownRoot(gh, findingBody("Nil map", 1));
    await platform.getPullRequest();
    await platform.listComments();
    const result = await platform.publish({
      review: review(gh),
      threadReplies: [{ in_reply_to: own.id, body: "**Verified fixed at `bbbbbbb`.** ok\n" }],
      resolveThreads: [{ comment_id: own.id, reason: "verified fixed" }],
    });
    assert.equal(postedReviews(gh).length, 1);
    assert.match((result.warnings ?? []).join("\n"), /not resolved: GitHub GraphQL: Resource not accessible by integration \(FORBIDDEN\)/);
  });

  test("a 5xx after GitHub created the review does not post a second one", async () => {
    const { gh, platform } = setup();
    gh.faults.push({ method: "POST", path: /\/reviews$/, status: 502, afterEffect: true });
    await platform.getPullRequest();
    const result = await platform.publish({ review: review(gh), threadReplies: [], resolveThreads: [] });
    assert.equal(gh.reviews.length, 1);
    assert.equal(result.commentIds[0], String(gh.reviews[0]!.id));
  });

  test("a rejected inline anchor moves the findings into the review body", async () => {
    const gh = new FakeGitHub({ invalidAnchors: ["a.go:99"] });
    const { platform } = setup(gh);
    await platform.getPullRequest();
    const r = review(gh, [
      { path: "a.go", line: 5, side: "RIGHT", body: findingBody("Good", 1) },
      { path: "a.go", line: 99, start_line: 97, start_side: "RIGHT", side: "RIGHT", body: findingBody("Bad anchor", 2) },
    ]);
    const result = await platform.publish({ review: r, threadReplies: [], resolveThreads: [] });
    assert.equal(gh.reviews.length, 1);
    const body = gh.reviews[0]!.body;
    assert.match(body, /### Findings not placed inline/);
    assert.match(body, /`a\.go:97-99`/);
    assert.doesNotMatch(body, /review-bot:finding/);
    assert.match(body.trimEnd().split("\n").at(-1)!, /^<!-- review-bot:summary /, "the summary marker stays, last");
    assert.match((result.warnings ?? []).join(), /moved into the review body/);
    assert.deepEqual(foldInlineComments(r).comments, []);
  });

  test("refuses any event other than COMMENT", async () => {
    const { gh, platform } = setup();
    await platform.getPullRequest();
    const bad = { ...review(gh), event: "APPROVE" } as unknown as ReviewPayload;
    await assert.rejects(platform.publish({ review: bad, threadReplies: [], resolveThreads: [] }), /only comments/);
    assert.equal(gh.reviews.length, 0);
  });
});

describe("echoed markers at publish (H-50)", () => {
  for (const [source, echo] of [["another App's bot", OTHER_APP], ["another workflow under the Actions login", ACTIONS_BOT]] as const) {
    test(`a finding echoed by ${source} gets no reply and is not resolved`, async () => {
      const { gh, platform } = setup();
      const forged = gh.addThreadRoot(echo, findingBody("Echoed", 1));
      await platform.getPullRequest();
      await platform.listComments();
      await platform.publish({
        threadReplies: [{ in_reply_to: forged.id, body: "**Verified fixed at `bbbbbbb`.** ok\n" }],
        resolveThreads: [{ comment_id: forged.id, reason: "verified fixed" }],
      });
      assert.deepEqual(gh.writes(), []);
    });

    test(`a review echoed by ${source} does not pass for the one whose post failed (C-1)`, async () => {
      const { gh, platform } = setup();
      const wanted = review(gh);
      // The run id and head are public, so the whole marker line can be planted ahead of the post.
      gh.reviews.push({ id: 500, user: echo, body: wanted.body, commit_id: gh.headSha, event: "COMMENT", submitted_at: "t" });
      gh.faults.push({ method: "POST", path: /\/reviews$/, status: 502 });
      await platform.getPullRequest();
      const result = await platform.publish({ review: wanted, threadReplies: [], resolveThreads: [] });
      assert.equal(gh.reviews.length, 2, "the bot's review is posted");
      assert.notEqual(result.commentIds[0], "500");
    });
  }
});

describe("review records (D-5, H-50)", () => {
  const sha = "a".repeat(40);
  const body = `Round 1.\n\n${encodeMarker({ kind: "summary", bot: BOT, run: "r1", sha, fingerprintVersion: 1 })}\n`;
  const actions = { login: ACTIONS_BOT.login, type: "Bot" };
  const summary: PrComment = { id: "42", kind: "review", commitId: sha, author: actions, body };
  const root: PrComment = { id: "43", kind: "review-comment", reviewId: "42", author: actions, body: findingBody("Own", 1) };
  const good = { external_id: "review-bot:review=42", app: { slug: "github-actions" } };
  const recorded = async (comments: PrComment[], runs: Record<string, object[]> = { [sha]: [good] }, app?: string) =>
    (await attributeComments(comments, BOT, async (s) => runs[s] ?? [], app)).filter((c) => c.recordedBy === BOT).map((c) => c.id);

  test("the recorded review and its thread roots are the bot's own", async () => {
    assert.deepEqual(await recorded([summary, root]), ["42", "43"]);
    assert.deepEqual(await recorded([summary, root], undefined, "github-actions"), ["42", "43"]);
  });

  test("nothing else is", async () => {
    // What a workflow job's own check run carries, whatever the job is called.
    const job = { external_id: "ffcb6881-061f-5161-b10a-876568429e75", app: { slug: "github-actions" } };
    assert.deepEqual(await recorded([summary], { [sha]: [job] }), [], "a job named like the check");
    assert.deepEqual(await recorded([summary], { [sha]: [{ ...good, app: { slug: "other-ci" } }] }), [], "another App's check run");
    assert.deepEqual(await recorded([summary], { [sha]: [{ external_id: good.external_id }] }), [], "no App");
    assert.deepEqual(await recorded([summary], undefined, "review-bot"), [], "not the App this run acts as");
    assert.deepEqual(await recorded([summary], { ["c".repeat(40)]: [good] }), [], "recorded on another commit");
    assert.deepEqual(await recorded([{ ...summary, commitId: "c".repeat(40) }]), [], "a review of another commit");
    const { commitId: _, ...noCommit } = summary;
    assert.deepEqual(await recorded([noCommit]), [], "a review without a commit");
    assert.deepEqual(await recorded([{ ...summary, body: body.replace(sha, "c".repeat(40)) }]), [], "edited to claim another commit");
    assert.deepEqual(await recorded([{ ...summary, id: "420" }]), [], "another review");
    assert.deepEqual(await recorded([{ ...summary, kind: "issue-comment" }]), [], "an issue comment with the same id");
    assert.deepEqual(await recorded([{ ...summary, author: { login: "dev", type: "User" } }]), [], "a person");
    assert.deepEqual(await recorded([summary, { ...root, reviewId: "99" }]), ["42"], "a root of another review");
    assert.deepEqual(await recorded([summary, { ...root, inReplyTo: "1" }]), ["42"], "a reply");
    assert.deepEqual(await recorded([root]), [], "a root without its review");
  });

  test("a commit GitHub no longer has is no record; an unreadable one fails the read instead of reviewing twice", async () => {
    for (const status of [404, 422]) {
      const { gh, platform } = setup();
      gh.reviews.push({ id: 42, user: ACTIONS_BOT, body, commit_id: sha, event: "COMMENT", submitted_at: "t" });
      gh.faults.push({ method: "GET", path: /\/check-runs$/, status });
      assert.equal((await platform.listComments())[0]!.recordedBy, undefined);
    }
    for (const status of [403, 500]) {
      const { gh, platform } = setup();
      gh.reviews.push({ id: 42, user: ACTIONS_BOT, body, commit_id: sha, event: "COMMENT", submitted_at: "t" });
      gh.faults.push({ method: "GET", path: /\/check-runs$/, status, times: 9 });
      await assert.rejects(platform.listComments());
    }
  });

  test("a record behind more than a page of later check runs is found", async () => {
    const { gh, platform } = setup();
    gh.addRecordedReview(BOT, sha, body);
    for (let i = 0; i < 120; i++) gh.checkRuns.push({ id: gh.id(), name: BOT, head_sha: sha, status: "completed", conclusion: "skipped" });
    assert.equal((await platform.listComments())[0]!.recordedBy, BOT);
  });

  test("a record that could not be written is written when the check completes, and outlives later updates", async () => {
    const { gh, client, platform } = setup(new FakeGitHub(), { maxAttempts: 1 });
    const pr = await platform.getPullRequest();
    await platform.startCheck(BOT, pr.headSha);
    gh.faults.push({ method: "PATCH", path: /\/check-runs\//, status: 502 });
    const result = await platform.publish({ review: review(gh), threadReplies: [], resolveThreads: [] });
    assert.match((result.warnings ?? []).join(), /not yet recorded/);
    assert.equal(gh.checkRuns[0]!.external_id, undefined);
    const done = { name: BOT, headSha: pr.headSha, conclusion: "success" as const, title: "Reviewed", summary: "ok" };
    await platform.completeCheck(done);
    const record = `review-bot:review=${gh.reviews[0]!.id}`;
    assert.equal(gh.checkRuns[0]!.external_id, record);
    await completeCheckRun(client, gh.repo, done, { onlyIfIncomplete: false });
    assert.equal(gh.checkRuns[0]!.external_id, record);
  });
});

describe("superseded run (S-9)", () => {
  test("head moved before publishing: nothing posted to the old head, no failure comment, check neutral 'superseded'", async () => {
    const { gh, platform } = setup();
    const own = ownRoot(gh, findingBody("Nil map", 1));
    const pr = await platform.getPullRequest();
    await platform.startCheck(BOT, pr.headSha);
    await platform.listComments();
    gh.push("c".repeat(40));
    const p: Publication = {
      review: review(gh, []),
      threadReplies: [{ in_reply_to: own.id, body: "**Verified fixed at `x`.**\n" }],
      resolveThreads: [{ comment_id: own.id, reason: "fixed" }],
    };
    p.review!.commit_id = pr.headSha;
    await assert.rejects(platform.publish(p), (e: unknown) => e instanceof SupersededError && /head moved from bbbbbbb to ccccccc/.test(e.message));
    // The pipeline then tries its failure comment: not posted, the newer run speaks for the PR.
    assert.deepEqual(await platform.publish({ threadReplies: [], resolveThreads: [], failureComment: "could not complete" }), { commentIds: [] });
    await platform.completeCheck({ name: BOT, headSha: pr.headSha, conclusion: "neutral", title: "Could not complete", summary: "Review could not complete: superseded" });
    assert.deepEqual(gh.writes().map((r) => `${r.method} ${r.path}`), [`POST /repos/o/r/check-runs`, `PATCH /repos/o/r/check-runs/${gh.checkRuns.at(-1)!.id}`]);
    assert.equal(gh.checkRuns.at(-1)!.head_sha, pr.headSha);
    assert.equal(gh.checkRuns.at(-1)!.conclusion, "neutral");
    assert.equal(gh.checkRuns.at(-1)!.output?.title, "Superseded by a newer push");
    assert.deepEqual(platform.report.superseded, { from: pr.headSha, to: "c".repeat(40) });
  });
});

describe("echoed failure markers (S-9, H-50)", () => {
  const APP: FakeUser = { login: "review-bot[bot]", type: "Bot" };
  for (const [identity, as] of [["App", APP], ["Actions token", ACTIONS_BOT]] as const) {
    for (const [source, echo] of [["another App's bot", OTHER_APP], ["another workflow under the Actions login", ACTIONS_BOT]] as const) {
      test(`${identity}: a comment echoed by ${source} is neither updated nor retired`, async () => {
        const gh = new FakeGitHub({ as });
        const echoed = gh.addIssueComment(echo, `Coverage report for the PR description:\n<!-- review-bot:failure bot=${BOT} -->\n<!-- review-bot:failure bot=${BOT} sha=${gh.headSha} -->`);
        const single = gh.addIssueComment(echo, `Coverage report\n\n<!-- review-bot:failure bot=${BOT} sha=${gh.headSha} -->\n`);
        const before = [echoed.body, single.body];
        const { platform } = setup(gh);
        const pr = await platform.getPullRequest();
        await platform.startCheck(BOT, pr.headSha);
        await platform.publish({ threadReplies: [], resolveThreads: [], failureComment: "Automated review could not complete for `bbbbbbb`: boom.\n" });
        assert.deepEqual([echoed.body, single.body], before, "echoes untouched");
        assert.equal(gh.issueComments.length, 3, "the bot posts its own comment");

        const next = setup(gh).platform;
        await next.getPullRequest();
        await next.publish({ review: review(gh), threadReplies: [], resolveThreads: [] });
        assert.deepEqual([echoed.body, single.body], before, "echoes not retired");
        assert.match(gh.issueComments[2]!.body, /The review of `bbbbbbb` completed/, "its own is retired");
      });
    }
  }
});

describe("failure comment (S-9)", () => {
  test("created once, then updated in place by marker; never someone else's; retired after a completed review", async () => {
    const { gh, platform } = setup();
    const open = async (p: GitHubPlatform) => {
      // The pipeline opens the check first; the comment's record goes on it.
      const pr = await p.getPullRequest();
      await p.startCheck(BOT, pr.headSha);
    };
    // A human quoting the marker, and another workflow's comment under the same login.
    gh.addIssueComment(HUMAN, `quote\n<!-- review-bot:failure bot=${BOT} -->`);
    gh.addIssueComment(ACTIONS_BOT, "Deploy preview ready");
    await open(platform);
    const first = await platform.publish({ threadReplies: [], resolveThreads: [], failureComment: "Automated review could not complete for `bbbbbbb`: boom.\n" });
    assert.equal(gh.issueComments.length, 3);
    const mine = gh.issueComments[2]!;
    assert.deepEqual(first.commentIds, [String(mine.id)]);
    assert.ok(hasFailureMarker(mine.body, BOT));

    // Next push, same failure: updated in place, not repeated.
    gh.push("c".repeat(40));
    const second = new GitHubPlatform({ client: setup(gh).client, repo: gh.repo, number: gh.number, botId: BOT });
    await open(second);
    const again = await second.publish({ threadReplies: [], resolveThreads: [], failureComment: "Automated review could not complete for `ccccccc`: boom again.\n" });
    assert.deepEqual(again.commentIds, [String(mine.id)]);
    assert.equal(gh.issueComments.length, 3);
    assert.match(mine.body, /`ccccccc`: boom again/);

    // A later completed review updates it so it no longer says the review failed.
    const third = new GitHubPlatform({ client: setup(gh).client, repo: gh.repo, number: gh.number, botId: BOT });
    await open(third);
    await third.publish({ review: review(gh), threadReplies: [], resolveThreads: [] });
    assert.equal(gh.issueComments.length, 3);
    assert.match(mine.body, /The review of `ccccccc` completed/);
    assert.ok(hasFailureMarker(mine.body, BOT));
    assert.match(gh.issueComments[0]!.body, /^quote/, "the human's comment is untouched");
  });

  test("its own comment without a record is left alone; an unreadable record or a retried post never edits or doubles (H-50)", async () => {
    // An old-format comment of this bot (before records) and one whose head's check runs cannot be read.
    const gh = new FakeGitHub();
    const old = gh.addIssueComment(ACTIONS_BOT, `Automated review could not complete.\n\n<!-- review-bot:failure bot=${BOT} -->\n`);
    const odd = "e".repeat(40);
    const unreadable = gh.addIssueComment(ACTIONS_BOT, `x\n\n<!-- review-bot:failure bot=${BOT} sha=${odd} -->\n`);
    gh.faults.push({ method: "GET", path: new RegExp(`/commits/${odd}/check-runs$`), status: 500, times: 99 });
    // The comment POST reaches GitHub but its answer is lost: found again by its attempt line, not posted twice.
    gh.faults.push({ method: "POST", path: /\/issues\/7\/comments$/, status: 502, afterEffect: true });
    const before = [old.body, unreadable.body];
    const { platform } = setup(gh);
    const pr = await platform.getPullRequest();
    await platform.startCheck(BOT, pr.headSha);
    const r = await platform.publish({ threadReplies: [], resolveThreads: [], failureComment: "Automated review could not complete for `bbbbbbb`: boom.\n" });
    assert.deepEqual([old.body, unreadable.body], before);
    assert.equal(gh.issueComments.length, 3);
    assert.deepEqual(r.commentIds, [String(gh.issueComments[2]!.id)]);
    assert.equal(gh.checkRuns[0]!.external_id, `review-bot:failure=${gh.issueComments[2]!.id}`);
  });

  test("a failure marker inside a code block or for another bot does not count", () => {
    assert.equal(hasFailureMarker("```\n<!-- review-bot:failure bot=ai-review/main -->\n```", BOT), false);
    assert.equal(hasFailureMarker("<!-- review-bot:failure bot=ai-review/other -->", BOT), false);
    assert.equal(hasFailureMarker("x\n  <!-- review-bot:failure bot=ai-review/main -->  \n", BOT), true);
  });
});

describe("check run ai-review/<name> (S-1, S-9)", () => {
  test("opened in progress at intake and completed in place", async () => {
    const { gh, platform } = setup();
    const pr = await platform.getPullRequest();
    await platform.startCheck(BOT, pr.headSha);
    assert.equal(gh.checkRuns.length, 1);
    assert.equal(gh.checkRuns[0]!.status, "in_progress");
    await platform.completeCheck({ name: BOT, headSha: pr.headSha, conclusion: "success", title: "Reviewed", summary: "1 important" });
    assert.equal(gh.checkRuns.length, 1);
    assert.deepEqual([gh.checkRuns[0]!.status, gh.checkRuns[0]!.conclusion, gh.checkRuns[0]!.output?.title], ["completed", "success", "Reviewed"]);
  });

  test("a queued run of the same name is reused instead of duplicated", async () => {
    const { gh, platform } = setup();
    gh.checkRuns.push({ id: 5, name: BOT, head_sha: gh.headSha, status: "queued", conclusion: null });
    await platform.startCheck(BOT, gh.headSha);
    assert.equal(gh.checkRuns.length, 1);
    assert.equal(gh.checkRuns[0]!.status, "in_progress");
  });

  test("standalone completion: closes an open run, creates a completed one when none, leaves a completed one alone", async () => {
    const { gh, client } = setup();
    const c = { name: BOT, headSha: gh.headSha, conclusion: "neutral" as const, title: "Could not complete", summary: "The review job crashed." };
    // Gate job, no run yet → created completed (e.g. skipped).
    assert.equal((await completeCheckRun(client, gh.repo, { ...c, conclusion: "skipped", title: "Skipped", summary: "Not authorized (C-4)." })).action, "created");
    assert.equal(gh.checkRuns[0]!.conclusion, "skipped");
    // Always-run step after the pipeline completed it: untouched.
    assert.equal((await completeCheckRun(client, gh.repo, c)).action, "already-completed");
    assert.equal(gh.checkRuns[0]!.conclusion, "skipped");
    // Always-run step after a crash left it in progress: completed neutral.
    const sha2 = "d".repeat(40);
    gh.checkRuns.push({ id: 77, name: BOT, head_sha: sha2, status: "in_progress", conclusion: null });
    assert.deepEqual(await completeCheckRun(client, gh.repo, { ...c, headSha: sha2 }), { action: "updated", id: 77 });
    assert.equal(gh.checkRuns[1]!.conclusion, "neutral");
    assert.equal((await findCheckRun(client, gh.repo, BOT, sha2))?.status, "completed");
    await assert.rejects(completeCheckRun(client, gh.repo, { ...c, name: "review" }), /invalid check name/);
    await assert.rejects(completeCheckRun(client, gh.repo, { ...c, headSha: "" }), /invalid head SHA/);
  });

  test("completing without a known head SHA fails clearly (the always-run step covers it)", async () => {
    const { platform } = setup();
    await assert.rejects(platform.completeCheck({ name: BOT, headSha: "", conclusion: "neutral", title: "x", summary: "y" }), /head SHA is unknown/);
  });
});

describe("reads", () => {
  test("comments normalized with thread state across pages; diff and incremental diff", async () => {
    const gh = new FakeGitHub({ pageSize: 1, diff: "diff --git a/a.go b/a.go\n" });
    const root = gh.addThreadRoot(ACTIONS_BOT, findingBody("x", 1), "a.go", 3, true);
    gh.addThreadRoot(HUMAN, "human", "a.go", 4);
    gh.reviewComments.push({ id: 5000, user: HUMAN, body: "[wrong] no", path: "a.go", line: null, in_reply_to_id: root.id, created_at: "t" });
    gh.addIssueComment(HUMAN, "hi");
    gh.reviews.push({ id: 6000, user: ACTIONS_BOT, body: "", commit_id: gh.headSha, event: "COMMENT", submitted_at: "t" });
    const { platform } = setup(gh);
    const comments = await platform.listComments();
    assert.deepEqual(
      comments.map((c) => [c.kind, c.threadResolved ?? null, c.inReplyTo ?? null]),
      [
        ["review-comment", true, null],
        ["review-comment", false, null],
        ["review-comment", null, String(root.id)],
        ["issue-comment", null, null],
      ],
    );
    assert.equal(await platform.getDiff(), "diff --git a/a.go b/a.go\n");
    const since = "e".repeat(40);
    gh.compare.set(`${since}...${gh.headSha}`, { status: "ahead", diff: "incremental" });
    assert.equal(await platform.getDiff(since), "incremental");
    gh.compare.set(`${since}...${gh.headSha}`, { status: "diverged", diff: "wrong base" });
    assert.equal(await platform.getDiff(since), undefined, "after a force push: full review");
    assert.equal(await platform.getDiff("f".repeat(40)), undefined, "unknown commit: full review");
  });
});
