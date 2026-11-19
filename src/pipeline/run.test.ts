/**
 * End-to-end pipeline runs (S-0 … S-9) on fixture PRs with pi's scripted
 * provider: no network, no key (AGENTS.md).
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { Value } from "typebox/value";
import { fauxAssistantMessage, fauxText, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { createPiSdkAgentStep, createScriptedProvider, type Script } from "../agent/index.ts";
import { decodeMarkers, encodeMarker, fingerprintFinding, RunRecord, type ProducerFinding } from "../core/index.ts";
import { DryRunPlatform, FixturePrReader, type PrComment, type PrReader } from "../platform/index.ts";
import { snapshotLookup } from "./lookup.ts";
import { type ConfigInputs } from "./config.ts";
import { runReview, type ReviewRunResult } from "./run.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "prs");
const BASIC = join(FIXTURES, "basic");
const HEAD = "89abcdef0123456789abcdef0123456789abcdef";
const PRIOR_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const STORE = "pkg/store/store.go";

const work = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-e2e-")));
after(() => rmSync(work, { recursive: true, force: true }));

const basicScript = (): Script => JSON.parse(readFileSync(join(BASIC, "script.json"), "utf8")) as Script;

/** Copy a fixture so a test can change it. */
function copyFixture(name: string): string {
  const dest = mkdtempSync(join(work, `${name}-`));
  cpSync(join(FIXTURES, name), dest, { recursive: true });
  return dest;
}

/** A reader with some parts replaced. */
function withComments(reader: PrReader, comments: PrComment[]): PrReader {
  return {
    kind: reader.kind,
    getPullRequest: () => reader.getPullRequest(),
    getDiff: (since) => reader.getDiff(since),
    listComments: async () => comments,
  };
}

interface RunOpts {
  dir?: string;
  script: Script;
  reader?: (fixture: FixturePrReader) => PrReader;
  inputs?: ConfigInputs;
}

async function run(o: RunOpts): Promise<{ result: ReviewRunResult; platform: DryRunPlatform; calls: string[]; logs: string[] }> {
  const fixture = new FixturePrReader(o.dir ?? BASIC);
  const platform = new DryRunPlatform(o.reader ? o.reader(fixture) : fixture);
  const scripted = createScriptedProvider(o.script);
  const logs: string[] = [];
  const result = await runReview({
    platform,
    snapshots: fixture.snapshots(),
    agentStep: createPiSdkAgentStep({ providers: [scripted.provider], retry: { enabled: false }, abortGraceMs: 2_000 }),
    inputs: o.inputs ?? { models: { reviewer: "scripted/reviewer", verifier: "scripted/verifier" } },
    runsDir: join(work, "runs"),
    log: (l) => logs.push(l),
  });
  return { result, platform, calls: scripted.calls, logs };
}

function readRecord(result: ReviewRunResult): RunRecord {
  assert.ok(result.recordPath, "a record path");
  const record = JSON.parse(readFileSync(result.recordPath, "utf8")) as RunRecord;
  const errors = [...Value.Errors(RunRecord, record)].map((e) => `${e.instancePath}: ${e.message}`);
  assert.deepEqual(errors, [], "the record matches the A-6 schema");
  return record;
}

const status = (r: RunRecord, title: RegExp) => r.findings.find((f) => title.test(f.title))?.status;

describe("normal run (S-0 … S-8)", async () => {
  const { result, platform, calls } = await run({ script: basicScript() });
  const out = platform.output;
  const record = readRecord(result);

  test("check run opened on the head SHA and completed as success (I-2 #1)", () => {
    assert.equal(result.conclusion, "success", result.checkSummary);
    assert.equal(out.check_run?.name, "ai-review/main");
    assert.equal(out.check_run?.head_sha, HEAD);
    assert.equal(out.check_run?.status, "completed");
    assert.equal(out.check_run?.output?.summary, "Reviewed 89abcde: 1 important, 1 nit, 1 pre-existing.");
  });

  test("one COMMENT review in GitHub payload shape, tag first, marker last (I-2 #3, #8)", () => {
    const review = out.review!;
    assert.equal(review.event, "COMMENT");
    assert.equal(review.commit_id, HEAD);
    assert.deepEqual(
      review.comments.map((c) => [c.path, c.line, c.side, c.body.split(" ")[0]]),
      [
        [STORE, 31, "RIGHT", "**Important.**"],
        [STORE, 24, "RIGHT", "**Nit.**"],
      ],
    );
    for (const c of review.comments) {
      const markers = decodeMarkers(c.body);
      assert.equal(markers.length, 1);
      assert.equal(markers[0]!.kind, "finding");
      assert.match(c.body.trimEnd().split("\n").pop()!, /^<!-- review-bot:finding /);
    }
    assert.match(review.comments[0]!.body, /\*\*Also at:\*\* `pkg\/store\/store\.go:26`/);
    assert.match(review.comments[0]!.body, /```suggestion\n/);
  });

  test("summary follows I-2 #11: count first, pre-existing with issue, questions, checked, not run, resolve line, needs-human last", () => {
    const body = out.review!.body;
    const blocks = body.split("\n\n");
    assert.match(blocks[0]!, /^Automated review, round 1\. It covers `89abcde`\./);
    assert.equal(blocks[1], "**1 important, 1 nit, 1 pre-existing.**");
    assert.match(body, /\*\*Pre-existing:\*\*\n- Get returns an untyped not-found error \(`pkg\/store\/store\.go:19`\)\. Proposed `tech-debt` issue/);
    assert.match(body, /\*\*Questions for the author:\*\*\n- Put replaces/);
    assert.match(body, /\*\*Checked, nothing found:\*\*\n- Callers of Put and Reset/);
    assert.match(body, /\*\*Not run:\*\*\n- go test/);
    const visible = body.replace(/\n<!-- review-bot:summary [^\n]*-->\n$/, "").trimEnd();
    assert.equal(visible.split("\n").pop(), "Needs human: changed test data in pkg/store/store_test.go:7. Explained in the description: no.");
    const summaryMarkers = decodeMarkers(body).filter((m) => m.kind === "summary");
    assert.equal(summaryMarkers.length, 1);
    assert.equal(summaryMarkers[0]!.kind === "summary" && summaryMarkers[0]!.sha, HEAD);
  });

  test("every finding is recorded with its final status and reason (A-6, S-5, S-6)", () => {
    assert.equal(record.findings.length, 7);
    assert.equal(status(record, /^Put after Reset/), "published");
    assert.equal(status(record, /^Get panics on a reset store/), "refuted");
    assert.equal(status(record, /^Put drops the value/), "refuted");
    assert.match(record.findings.find((f) => /^Put drops/.test(f.title))!.statusReason!, /^evidence not found/);
    assert.equal(status(record, /^Put's comment/), "over-limit");
    assert.equal(status(record, /^The test does not cover Reset/), "duplicate");
    assert.match(record.findings.find((f) => /^The test does not/.test(f.title))!.statusReason!, /maintainer in comment 5001/);
    for (const f of record.findings) if (f.status !== "published") assert.ok(f.statusReason, `${f.id} has a reason`);
  });

  test("record: versions, roles as configured, steps, rejected calls, knowledge from base (A-6, D-7)", () => {
    assert.equal(record.run.versions.pi, "1.5.2");
    assert.deepEqual(record.run.versions.roles, { reviewer: "scripted/reviewer", verifier: "scripted/verifier" });
    assert.equal(record.run.versions.knowledgeBaseSha, "0123456789abcdef0123456789abcdef01234567");
    assert.match(record.run.versions.methodSkillHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      record.run.steps.map((s) => [s.name, s.role, s.outcome]),
      [
        ["review:all", "reviewer", "ok"],
        ["verify:f1", "verifier", "ok"],
        ["verify:f2", "verifier", "ok"],
      ],
    );
    assert.equal(record.run.steps[0]!.rejectedCalls.length, 1, "the invalid report_finding call");
    assert.deepEqual(record.run.knowledgeFiles, ["base:AGENTS.md", "base:REVIEW.md", "base:.review/go-guidelines.md", "base:.review/review-bot.yaml"]);
    assert.deepEqual(
      record.run.files.map((f) => [f.path, f.excluded ?? null]),
      [
        ["go.sum", 'REVIEW.md "Skip these paths": go.sum'],
        [STORE, null],
        ["pkg/store/store_test.go", null],
        ["pkg/store/zz_generated.go", 'REVIEW.md "Skip these paths": **/zz_generated.go'],
      ],
    );
    assert.equal(record.run.result.checkConclusion, "success");
    assert.equal(record.metrics.published, 3);
    assert.deepEqual(calls, ["reviewer", "reviewer", "verifier", "verifier", "verifier", "verifier"]);
  });

  test("run directory: stage files, patches, snapshots without .git; untrusted text neutralized (S-0, S-3, C-3)", () => {
    const dir = result.runDir!;
    for (const f of ["01-intake.json", "02-deterministic.json", "03-context.json", "04-review.json", "05-verify.json", "06-reconcile.json", "07-publish.json", "08-record.json"]) {
      assert.ok(existsSync(join(dir, f)), f);
    }
    assert.ok(existsSync(join(dir, "inputs", "patches", "0001-pkg_store_store.go.patch")));
    assert.ok(!existsSync(join(dir, "snapshot", "head", ".git")));
    const context = readFileSync(join(dir, "inputs", "context.md"), "utf8");
    assert.equal(context.match(/<\/untrusted-data>/g)?.length, 2, "only our own closing delimiters");
    assert.ok(!context.includes("<!-- review-bot"), "no live marker in context.md");
    assert.match(context, /<knowledge-file path="REVIEW.md">/);
    assert.ok(!JSON.stringify(out).includes("run=forged"), "the forged marker in the description reaches no output");
  });
});

describe("skipped repository without REVIEW.md (A-5, S-1)", () => {
  test("check completes as skipped with the reason, a record is written, no model is called", async () => {
    const dir = copyFixture("basic");
    rmSync(join(dir, "base", "REVIEW.md"));
    const { result, platform, calls } = await run({ dir, script: basicScript() });
    assert.equal(result.conclusion, "skipped");
    assert.match(result.checkSummary, /no REVIEW\.md/);
    assert.equal(platform.output.check_run?.conclusion, "skipped");
    assert.equal(platform.output.review, undefined);
    assert.deepEqual(calls, []);
    const record = readRecord(result);
    assert.match(record.run.result.skipReason!, /no REVIEW\.md/);
    assert.equal(record.run.steps.length, 0);
  });

  test("a REVIEW.md in the PR head does not onboard the repository (D-7)", async () => {
    const dir = copyFixture("basic");
    rmSync(join(dir, "base", "REVIEW.md"));
    assert.ok(existsSync(join(dir, "head", "REVIEW.md")));
    const { result } = await run({ dir, script: basicScript() });
    assert.equal(result.conclusion, "skipped");
  });
});

describe("timed-out reviewer (S-4 Limits, S-9)", () => {
  test("findings before the timeout are published, labelled partial; check neutral; usage marked incomplete", async () => {
    const script = basicScript();
    const first = (script.reviewer![0] as { toolCalls: Array<{ name: string }> }).toolCalls[0]!;
    const hang: FauxResponseFactory = async (_c, options) => {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 15_000);
        options?.signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
      });
      return fauxAssistantMessage(fauxText("late"));
    };
    script.reviewer = [{ toolCalls: [first as never] }, hang];
    const { result, platform } = await run({
      script,
      inputs: {
        models: { reviewer: "scripted/reviewer", verifier: "scripted/verifier" },
        limits: { reviewer: { timeoutMs: 600 } },
      },
    });
    assert.equal(result.conclusion, "neutral");
    assert.match(result.checkSummary, /^Partial review of 89abcde \(1 important, 0 nits, 0 pre-existing\)/);
    const body = platform.output.review!.body;
    assert.match(body, /\*\*Partial review:\*\* the reviewer step for the change ended early \(timeout, timeout\)/);
    assert.equal(platform.output.review!.comments.length, 1);
    const record = readRecord(result);
    const review = record.run.steps.find((s) => s.name === "review:all")!;
    assert.equal(review.outcome, "timeout");
    assert.equal(review.usageComplete, false);
    assert.equal(record.metrics.stepsWithIncompleteUsage, 1);
    assert.equal(record.run.result.checkConclusion, "neutral");
  });
});

describe("refuted finding (S-5)", () => {
  test("refuted with evidence → dropped; refuted with evidence that is not there → kept as unverified (P-7)", async () => {
    const script = basicScript();
    const verdicts = script.verifier!;
    // Second verdict: a refutation citing code that does not exist.
    verdicts[2] = {
      toolCalls: [
        {
          name: "submit_verdict",
          arguments: {
            verdict: "refuted",
            reasoning: "made up",
            evidence: [{ root: "head", path: STORE, startLine: 17, endLine: 17, quote: "if s.items == nil" }],
          },
        },
      ],
    };
    const { result, platform } = await run({ script });
    const record = readRecord(result);
    const f2 = record.findings.find((f) => /^Get panics/.test(f.title))!;
    assert.equal(f2.status, "published");
    assert.equal(f2.verdict?.verdict, "refuted");
    const comment = platform.output.review!.comments.find((c) => c.line === 25)!;
    assert.match(comment.body, /^\*\*Important\.\*\* Get panics on a reset store\.\n\n_Unverified:/);

    const confirmed = await run({ script: basicScript() });
    const refuted = readRecord(confirmed.result).findings.find((f) => /^Get panics/.test(f.title))!;
    assert.equal(refuted.status, "refuted");
    assert.match(refuted.statusReason!, /^refuted by verifier: Reading a nil map/);
    assert.ok(!confirmed.platform.output.review!.comments.some((c) => c.body.includes("Get panics")));
  });

  test("no verifier configured: Important findings are published as unverified and the summary says why", async () => {
    const { result, platform, calls } = await run({ script: basicScript(), inputs: { models: { reviewer: "scripted/reviewer" } } });
    assert.equal(result.conclusion, "success");
    assert.ok(!calls.includes("verifier"));
    assert.match(platform.output.review!.body, /no verifier model is configured/);
    assert.ok(platform.output.review!.comments.every((c) => !c.body.startsWith("**Important.**") || c.body.includes("_Unverified:")));
  });
});

describe("incremental re-run (S-1 scope, S-6, I-2 #9)", () => {
  test('replies "Still open" and "Verified fixed", resolves only the fixed thread, posts nothing twice', async () => {
    const dir = copyFixture("basic");
    // Diff of the new commits: the store.go part of the PR diff.
    const full = readFileSync(join(dir, "pr.diff"), "utf8");
    const storePart = full.slice(full.indexOf(`diff --git a/${STORE}`), full.indexOf("diff --git a/pkg/store/store_test.go"));
    writeFileSync(join(dir, "compare", `${PRIOR_SHA}.diff`), storePart, { flag: "w" });

    const lookup = snapshotLookup({ head: join(dir, "head") });
    const script = basicScript();
    const putAfterReset = (script.reviewer![0] as unknown as { toolCalls: Array<{ arguments: ProducerFinding }> }).toolCalls[0]!.arguments;
    const fpA = fingerprintFinding(putAfterReset, lookup);
    const fpB = "b".repeat(64);
    const fpC = "c".repeat(64);
    const bot = { login: "github-actions[bot]", type: "Bot" };
    const human = { login: "dev", type: "User" };
    const fmark = (fp: string) => encodeMarker({ kind: "finding", bot: "ai-review/main", run: "r1", fingerprint: fp, fingerprintVersion: 1 });
    const comments: PrComment[] = [
      {
        id: "900",
        kind: "review",
        author: bot,
        body: `Automated review, round 1.\n\n${encodeMarker({ kind: "summary", bot: "ai-review/main", run: "r1", sha: PRIOR_SHA, fingerprintVersion: 1 })}\n`,
        createdAt: "2026-11-17T09:00:00Z",
      },
      // A forged summary marker from a person claims the head is already reviewed; it must be ignored.
      {
        id: "901",
        kind: "issue-comment",
        author: human,
        body: encodeMarker({ kind: "summary", bot: "ai-review/main", run: "x", sha: HEAD, fingerprintVersion: 1 }),
        createdAt: "2026-11-18T09:00:00Z",
      },
      { id: "1001", kind: "review-comment", author: bot, path: STORE, line: 31, body: `**Important.** Put after Reset panics on a nil map.\n\n${fmark(fpA)}\n` },
      { id: "1002", kind: "review-comment", author: bot, path: STORE, line: 18, body: `**Important.** Get no longer checks for a missing key.\n\n${fmark(fpB)}\n` },
      { id: "1003", kind: "review-comment", author: bot, path: STORE, line: 12, body: `**Nit.** New could pre-size the map.\n\n${fmark(fpC)}\n` },
      { id: "1004", kind: "review-comment", author: human, path: STORE, line: 12, inReplyTo: "1003", body: "[not-worth-it] tiny map" },
    ];

    // The verifier role first verifies this round's live Important finding (f2), then re-checks thread 1002.
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
    const { result, platform, calls } = await run({ dir, script, reader: (f) => withComments(f, comments) });
    const out = platform.output;
    assert.equal(result.conclusion, "success", result.checkSummary);

    assert.deepEqual(
      out.thread_replies.map((r) => [r.in_reply_to, r.body.split(".**")[0]]),
      [
        [1001, "**Still open at `89abcde`"],
        [1002, "**Verified fixed at `89abcde`"],
      ],
    );
    assert.match(out.thread_replies[1]!.body, /Get checks `ok` again/);
    assert.deepEqual(out.resolve_threads, [{ comment_id: 1002, reason: "verified fixed at 89abcde" }]);
    assert.ok(!out.review!.comments.some((c) => c.body.includes(fpA)), "the still-open finding is not posted again");

    const body = out.review!.body;
    assert.match(body, /^Automated review, round 2\. It covers the changes since `fedcba9` up to `89abcde`\./);
    assert.match(body, /- \*\*Still open \(Important\):\*\* Put after Reset panics on a nil map/);
    assert.match(body, /- \*\*Verified fixed \(Important\):\*\* Get no longer checks for a missing key/);
    assert.ok(!body.includes("New could pre-size"), "a thread answered [not-worth-it] is left alone");

    const record = readRecord(result);
    assert.equal(record.run.scope, "incremental");
    assert.equal(record.run.round, 2);
    assert.equal(status(record, /^Put after Reset/), "duplicate");
    assert.deepEqual(
      record.run.steps.map((s) => s.name),
      ["review:all", "verify:f2", "recheck:1002"],
      "no verifier step for the finding already posted, no re-check for the answered or reproduced ones",
    );
    assert.deepEqual(calls, ["reviewer", "reviewer", "verifier", "verifier", "verifier", "verifier"]);
  });

  test("re-running on an already reviewed head is skipped (C-1 idempotent)", async () => {
    const comments: PrComment[] = [
      {
        id: "900",
        kind: "review",
        author: { login: "github-actions[bot]", type: "Bot" },
        body: encodeMarker({ kind: "summary", bot: "ai-review/main", run: "r1", sha: HEAD, fingerprintVersion: 1 }),
      },
    ];
    const { result, calls } = await run({ script: basicScript(), reader: (f) => withComments(f, comments) });
    assert.equal(result.conclusion, "skipped");
    assert.match(result.checkSummary, /already reviewed/);
    assert.deepEqual(calls, []);
  });
});

describe("failure behaviour (S-9, D-14)", () => {
  test("no reviewer model: neutral check, failure comment, record", async () => {
    const { result, platform } = await run({ script: basicScript(), inputs: {} });
    assert.equal(result.conclusion, "neutral");
    assert.match(result.checkSummary, /no model is configured for the reviewer role/);
    assert.match(platform.output.failure_comment!, /^Automated review could not complete for `89abcde`/);
    assert.equal(platform.output.review, undefined);
    assert.equal(readRecord(result).run.result.checkConclusion, "neutral");
  });

  test("a reviewer that fails before producing anything: neutral, no review", async () => {
    const { result, platform } = await run({
      script: { reviewer: [() => fauxAssistantMessage(fauxText(""), { stopReason: "error", errorMessage: "provider exploded" })] },
      inputs: { models: { reviewer: "scripted/reviewer" } },
    });
    assert.equal(result.conclusion, "neutral");
    assert.match(result.checkSummary, /the reviewer produced nothing: provider exploded/);
    assert.equal(platform.output.review, undefined);
    assert.equal(platform.output.check_run?.status, "completed");
  });

  test("the PR cannot be read: the check is still completed and a record written", async () => {
    const broken: PrReader = {
      kind: "broken",
      getPullRequest: async () => {
        throw new Error("network down");
      },
      getDiff: async () => undefined,
      listComments: async () => [],
    };
    const { result, platform } = await run({ script: basicScript(), reader: () => broken });
    assert.equal(result.conclusion, "neutral");
    assert.equal(platform.output.check_run?.status, "completed");
    assert.ok(result.recordPath && existsSync(result.recordPath));
  });
});
