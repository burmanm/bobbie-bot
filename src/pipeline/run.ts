/**
 * The review run (03-review-pipeline.md): S-0 run directory, S-1 intake,
 * S-2 deterministic pass, S-3 context, S-4 review, S-5 verify, S-6
 * reconcile, S-7 publish, S-8 record, with S-9 failure behaviour around all
 * of it. Code controls flow (P-3); only S-4, S-5 and the re-check of
 * earlier findings call a model.
 *
 * Every exit path completes the check run once and writes a run record
 * (S-9, D-14). Each stage writes its output to `NN-stage.json` in the run
 * directory (S-0).
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Value } from "typebox/value";
import type { AgentStep, AgentStepResult, ModelRef, OutputTool, ReadRoots } from "../agent/index.ts";
import { PI_VERSION } from "../agent/index.ts";
import {
  applyVerdict,
  BOT_VERSION,
  type Evidence,
  type FileRecord,
  type Finding,
  FINGERPRINT_VERSION,
  fingerprintFinding,
  groundFindings,
  indexDiff,
  isInDiff,
  isLive,
  type NeedsHumanNote,
  parseDiff,
  parseReviewMd,
  preExistingItems,
  producerPart,
  type Question,
  quoteFound,
  reconcile,
  renderSummary,
  RUN_RECORD_SCHEMA_VERSION,
  RUN_RECORD_TOOL,
  RunRecord,
  runMetrics,
  type StepRecord,
  summaryCounts,
  type Verdict,
} from "../core/index.ts";
import type { EarlierFinding } from "../core/summary.ts";
import {
  assertIsolatedLocation,
  type CheckConclusion,
  type Platform,
  type PrComment,
  type Publication,
  type PullRequestInfo,
  type SnapshotSource,
} from "../platform/index.ts";
import { type ConfigInputs, ConfigError, formatModel, type PipelineConfig, type PipelineRole, resolveConfig } from "./config.ts";
import { buildContext } from "./context.ts";
import { type Chunk, chunkByDirectory, deterministicPass, type DeterministicResult } from "./deterministic.ts";
import { isKnowledgePath, type Knowledge, knowledgeFileList, type KnowledgeOverride, loadKnowledge } from "./knowledge.ts";
import { snapshotLookup } from "./lookup.ts";
import { loadMethod, type Method } from "./method.ts";
import { buildReview, failureCommentBody, recheckReplyBody } from "./publish.ts";
import { derivePriorState, openPriorFindings, type PriorFinding, type PriorState } from "./prior.ts";
import { isValidRecheck, type Recheck, RECHECK_TOOLS, REVIEWER_TOOLS, VERIFIER_TOOLS } from "./tools.ts";

export interface ReviewRunOptions {
  platform: Platform;
  snapshots: SnapshotSource;
  agentStep: AgentStep;
  /** Workflow inputs / CLI flags; `.review/review-bot.yaml` from base overrides them (C-2). */
  inputs: ConfigInputs;
  /** Reviewer name: the check run is `ai-review/<name>` and markers carry the same id. Default "main". */
  name?: string;
  knowledgeOverride?: KnowledgeOverride;
  /** Dependency source cache (Go module cache), read-only. */
  modcache?: string;
  /** Parent of the run directory. Must have no `.git` or context files above it (C-3a). */
  runsDir: string;
  runId?: string;
  trigger?: string;
  now?: () => Date;
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Where the pi package lives (method skill and prompts). */
  methodDir?: string;
}

export interface ReviewRunResult {
  runId: string;
  runDir?: string;
  conclusion: CheckConclusion;
  checkSummary: string;
  publication?: Publication;
  record?: RunRecord;
  recordPath?: string;
}

export interface RecheckOutcome {
  commentId: string;
  fingerprint: string;
  title: string;
  tag?: "important" | "nit";
  status: "fixed" | "still-open" | "inconclusive" | "not-checked";
  detail: string;
  /** How the status was decided. */
  by: "fingerprint" | "model" | "none";
}

const READ_TOOLS = ["read", "ls", "grep", "find"] as const;
const short = (sha: string) => sha.slice(0, 7);

/** A run that cannot continue; becomes a neutral check (S-9). */
class RunFailure extends Error {
  override name = "RunFailure";
}

function defaultRunId(now: Date): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `local-${ts}-${randomBytes(3).toString("hex")}`;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runReview(o: ReviewRunOptions): Promise<ReviewRunResult> {
  const now = o.now ?? (() => new Date());
  const startedAt = now();
  const started = performance.now();
  const runId = o.runId ?? process.env.GITHUB_RUN_ID ?? defaultRunId(startedAt);
  const name = o.name ?? "main";
  const botId = `ai-review/${name}`;
  const log = o.log ?? (() => {});

  // Everything the record needs, filled as the run goes.
  let runDir: string | undefined;
  let pr: PullRequestInfo | undefined;
  let config: PipelineConfig | undefined;
  let knowledge: Knowledge | undefined;
  let method: Method | undefined;
  let scope: "full" | "incremental" = "full";
  let round = 1;
  let files: FileRecord[] = [];
  const steps: StepRecord[] = [];
  let findings: Finding[] = [];
  const questions: Question[] = [];
  const needsHuman: NeedsHumanNote[] = [];
  let conclusion: CheckConclusion = "neutral";
  let checkSummary = "Review did not start.";
  let skipReason: string | undefined;
  let publication: Publication | undefined;
  let published = false;
  let checkCompleted = false;
  let spentUsd = 0;
  let publishedIds: string[] = [];

  const stage = (file: string, data: unknown) => {
    if (runDir === undefined) return;
    writeFileSync(join(runDir, file), JSON.stringify(data, null, 2) + "\n");
  };
  const timed = async <T>(label: string, fn: () => Promise<T>, detail?: (r: T) => string): Promise<T> => {
    const t = performance.now();
    try {
      const r = await fn();
      log(`${label} ok ${Math.round(performance.now() - t)}ms${detail ? ` ${detail(r)}` : ""}`);
      return r;
    } catch (e) {
      log(`${label} failed ${Math.round(performance.now() - t)}ms: ${errorMessage(e)}`);
      throw e;
    }
  };
  const checkCancelled = () => {
    if (o.signal?.aborted) throw new RunFailure("cancelled");
  };

  const complete = async (c: CheckConclusion, summary: string) => {
    conclusion = c;
    checkSummary = summary;
    if (checkCompleted) return;
    checkCompleted = true;
    try {
      await o.platform.completeCheck({
        name: botId,
        headSha: pr?.headSha ?? "",
        conclusion: c,
        title: c === "success" ? "Reviewed" : c === "skipped" ? "Skipped" : "Could not complete",
        summary,
      });
    } catch (e) {
      log(`check completion failed: ${errorMessage(e)}`);
    }
  };

  /** One model step, within the run's spend cap. Undefined when the cap left no budget. */
  const step = async <T extends OutputTool>(
    stepName: string,
    role: PipelineRole,
    model: ModelRef,
    req: { systemPrompt: string; prompt: string; roots: ReadRoots; outputTools: readonly T[] },
  ): Promise<AgentStepResult<T> | undefined> => {
    checkCancelled();
    const remaining = config!.limits.runCostUsd - spentUsd;
    if (remaining <= 0) {
      log(`${stepName} not run: run spend cap of $${config!.limits.runCostUsd} reached`);
      return undefined;
    }
    const roleLimits = config!.limits[role];
    const maxCostUsd = Math.min(roleLimits.maxCostUsd ?? Infinity, remaining);
    let lastBeat = 0;
    const t = performance.now();
    const result = await o.agentStep.run({
      role,
      model,
      systemPrompt: req.systemPrompt,
      prompt: req.prompt,
      roots: req.roots,
      readTools: READ_TOOLS,
      outputTools: req.outputTools,
      limits: { ...roleLimits, maxCostUsd },
      ...(o.signal === undefined ? {} : { signal: o.signal }),
      onProgress: (p) => {
        // C-8 heartbeat, at most every 30 seconds.
        if (performance.now() - lastBeat < 30_000) return;
        lastBeat = performance.now();
        log(`${stepName} working: ${p.turns} turns, $${p.costUsd.toFixed(4)}${p.lastTool ? `, last tool ${p.lastTool}` : ""}`);
      },
    });
    spentUsd += result.usage.costUsd;
    const record: StepRecord = {
      name: stepName,
      role,
      configuredModel: formatModel(model),
      servedModels: result.servedModels,
      outcome: result.outcome,
      usage: {
        turns: result.usage.turns,
        input: result.usage.input,
        output: result.usage.output,
        cacheRead: result.usage.cacheRead,
        cacheWrite: result.usage.cacheWrite,
        costUsd: result.usage.costUsd,
        costIsBilled: result.usage.costIsBilled,
        wallMs: result.usage.wallMs,
      },
      usageComplete: result.usage.usageComplete,
      rejectedCalls: result.rejectedCalls.map((r) => ({ tool: r.tool, reason: `${r.kind}: ${r.reason}` })),
    };
    const err = result.error ? `${result.error.kind}: ${result.error.message}` : result.stoppedBy ? `stopped by ${result.stoppedBy}` : undefined;
    if (err !== undefined) record.error = err;
    steps.push(record);
    log(
      `${stepName} ${result.outcome} ${Math.round(performance.now() - t)}ms turns=${result.usage.turns} outputs=${result.outputs.length} cost=$${result.usage.costUsd.toFixed(4)}${err ? ` (${err})` : ""}`,
    );
    return result;
  };

  try {
    // ---- S-0 run directory ------------------------------------------------
    const runsDir = resolve(o.runsDir);
    mkdirSync(runsDir, { recursive: true });
    assertIsolatedLocation(runsDir);
    runDir = join(runsDir, `run-${runId}`);
    mkdirSync(runDir, { recursive: false });
    const heads = { head: join(runDir, "snapshot", "head"), base: join(runDir, "snapshot", "base") };
    const inputsDir = join(runDir, "inputs");
    mkdirSync(inputsDir, { recursive: true });
    method = loadMethod(o.methodDir);
    log(`S-0 run directory ${runDir}`);

    // ---- S-1 intake -------------------------------------------------------
    pr = await timed("S-1 pull request", () => o.platform.getPullRequest(), (p) => `${p.repo}#${p.number} head ${short(p.headSha)}`);
    await o.platform.startCheck(botId, pr.headSha);
    const comments: PrComment[] = await timed("S-1 comments", () => o.platform.listComments(), (c) => `${c.length}`);
    const currentPr = pr;
    await timed("S-1 base snapshot", () => o.snapshots.extract("base", currentPr.baseSha, heads.base));
    knowledge = loadKnowledge(heads.base, o.knowledgeOverride ?? {});
    config = resolveConfig(o.inputs, knowledge.botConfig?.text);
    const prior: PriorState = derivePriorState(comments, botId);
    round = prior.rounds + 1;

    const skip = ((): string | undefined => {
      if (knowledge.review === undefined) return "the repository has no REVIEW.md on the base branch, so it is not onboarded for automated review (A-5)";
      if (pr.draft && config.skip.draft) return "the pull request is a draft";
      const label = pr.labels.find((l) => config!.skip.labels.includes(l));
      if (label !== undefined) return `the pull request has the label "${label}"`;
      if (prior.lastReviewedSha === pr.headSha) return `head ${short(pr.headSha)} was already reviewed (run is idempotent, C-1)`;
      return undefined;
    })();

    let sinceSha: string | undefined;
    let reviewDiffText: string | undefined;
    let fullDiffText: string | undefined;
    if (skip === undefined) {
      fullDiffText = await timed("S-1 diff", () => o.platform.getDiff(), (d) => `${d?.length ?? 0} bytes`);
      if (fullDiffText === undefined) throw new RunFailure("the platform returned no diff");
      if (prior.lastReviewedSha !== undefined) {
        const since = prior.lastReviewedSha;
        const d = await timed("S-1 incremental diff", () => o.platform.getDiff(since), (x) => (x === undefined ? "unavailable, full review" : `${x.length} bytes`));
        if (d !== undefined) {
          scope = "incremental";
          sinceSha = since;
          reviewDiffText = d;
        }
      }
      reviewDiffText ??= fullDiffText;
    }

    stage("01-intake.json", {
      runId,
      bot: botId,
      pr,
      comments: comments.length,
      prior: {
        lastReviewedSha: prior.lastReviewedSha,
        rounds: prior.rounds,
        findings: prior.findings.map(({ body: _b, ...rest }) => rest),
        othersInline: prior.othersInline.length,
      },
      scope,
      sinceSha,
      round,
      roles: Object.fromEntries(Object.entries(config.roles).map(([k, v]) => [k, formatModel(v)])),
      limits: config.limits,
      knowledge: knowledgeFileList(knowledge),
      modcache: o.modcache ?? null,
      skip: skip ?? null,
    });

    if (skip !== undefined) {
      skipReason = skip;
      log(`S-1 skipped: ${skip}`);
      await complete("skipped", `Skipped: ${skip}.`);
      return await finish();
    }

    const reviewerModel = config.roles.reviewer;
    if (reviewerModel === undefined) {
      throw new ConfigError("no model is configured for the reviewer role (set --model reviewer=<provider>/<id> or roles.reviewer in .review/review-bot.yaml)");
    }
    const verifierModel = config.roles.verifier;
    await timed("S-1 head snapshot", () => o.snapshots.extract("head", currentPr.headSha, heads.head));
    checkCancelled();

    // ---- S-2 deterministic pass ------------------------------------------
    const reviewMd = parseReviewMd(knowledge.review!.text);
    const det: DeterministicResult = deterministicPass(reviewDiffText!, reviewMd, inputsDir);
    const fullFiles = scope === "incremental" ? parseDiff(fullDiffText!) : det.all;
    const fullIndex = indexDiff(fullFiles.filter((f) => !f.binary));
    const excludedReason = new Map(det.excluded.map((e) => [e.path, e.reason]));
    files = det.all.map((f) => {
      const r: FileRecord = { path: f.path, status: f.status, binary: f.binary };
      if (f.oldPath !== undefined && f.oldPath !== f.path) r.oldPath = f.oldPath;
      const reason = excludedReason.get(f.path);
      if (reason !== undefined) r.excluded = reason;
      return r;
    });
    const knowledgeEditedByPr = [
      ...new Set(fullFiles.flatMap((f) => [f.newPath, f.oldPath]).filter((p): p is string => p !== undefined && isKnowledgePath(p))),
    ].sort();
    const chunks: Chunk[] = det.patches.length === 0 ? [] : chunkByDirectory(det.patches, config.limits.chunkPatchLines);
    stage("02-deterministic.json", {
      scope,
      sinceSha,
      reviewMd: { skipEntries: reviewMd.skipEntries, nitCap: reviewMd.nitCap, found: reviewMd.found, unparsedSkipItems: reviewMd.unparsedSkipItems },
      patches: det.patches,
      excluded: det.excluded,
      softSkips: det.softSkips,
      knowledgeEditedByPr,
      chunks: chunks.map((c) => ({ name: c.name, dirs: c.dirs, files: c.files.map((f) => f.path), lines: c.lines })),
    });
    log(`S-2 deterministic ok files=${det.all.length} reviewed=${det.included.length} excluded=${det.excluded.length} chunks=${chunks.length}`);

    const priorOpen = openPriorFindings(prior);
    if (det.patches.length === 0 && priorOpen.length === 0) {
      skipReason = "no reviewable files";
      await complete("success", `Nothing to review at ${short(pr.headSha)}: every changed file is skipped (${det.excluded.map((e) => e.reason).join("; ") || "empty diff"}).`);
      return await finish();
    }

    // ---- S-3 context ------------------------------------------------------
    const contextMd = buildContext({
      pr,
      scope,
      ...(sinceSha === undefined ? {} : { sinceSha }),
      patches: det.patches,
      excluded: det.excluded,
      softSkips: det.softSkips,
      knowledge,
      knowledgeSha: pr.baseSha,
      knowledgeEditedByPr,
      comments,
      priorOpen,
      hasModcache: o.modcache !== undefined,
    });
    writeFileSync(join(inputsDir, "context.md"), contextMd);
    stage("03-context.json", { path: "inputs/context.md", bytes: Buffer.byteLength(contextMd) });
    log(`S-3 context ok ${Buffer.byteLength(contextMd)} bytes`);

    const roots: ReadRoots = { head: heads.head, base: heads.base, inputs: inputsDir };
    if (o.modcache !== undefined) roots.modcache = o.modcache;
    const lookupRoots: { head: string; base: string; modcache?: string } = { head: heads.head, base: heads.base };
    if (o.modcache !== undefined) lookupRoots.modcache = o.modcache;
    const lookup = snapshotLookup(lookupRoots);
    const notRun: string[] = [];
    const checked: string[] = [];
    const partial: string[] = [];

    // ---- S-4 review -------------------------------------------------------
    let findingSeq = 0;
    let reviewerOk = 0;
    let reviewerOutputs = 0;
    const reviewerErrors: string[] = [];
    for (const chunk of chunks) {
      const scopeText =
        chunk.name === "all"
          ? "Review every file in the change map."
          : `This pull request is reviewed in ${chunks.length} parts. Your part is ${chunk.name}: ${chunk.files.map((f) => `\`${f.path}\``).join(", ")}. Read other files as needed, but report findings only for your part.`;
      const prompt = `${contextMd}\n\n---\n\n# Your task\n\n${scopeText}\n\nThe review context above is also at \`context.md\` in the inputs root; the patches are under \`patches/\` there. Follow the review method. Report only through the tools.\n`;
      const result = await step(`review:${chunk.name}`, "reviewer", reviewerModel, {
        systemPrompt: method.reviewer,
        prompt,
        roots,
        outputTools: REVIEWER_TOOLS,
      });
      if (result === undefined) {
        partial.push(`the reviewer step for ${chunk.name === "all" ? "the change" : chunk.name} was not run: the run spend cap was reached`);
        continue;
      }
      reviewerOutputs += result.outputs.length;
      if (result.outcome === "ok") reviewerOk++;
      else {
        const why = result.error?.message ?? `stopped by ${result.stoppedBy ?? result.outcome}`;
        reviewerErrors.push(why);
        partial.push(
          `the reviewer step for ${chunk.name === "all" ? "the change" : chunk.name} ended early (${result.outcome}${result.stoppedBy ? `, ${result.stoppedBy}` : ""}); findings reported before that are included`,
        );
      }
      for (const out of result.outputs) {
        switch (out.tool) {
          case "report_finding": {
            const v = out.value;
            findings.push({
              ...v,
              id: `f${++findingSeq}`,
              fingerprint: fingerprintFinding(v, lookup),
              fingerprintVersion: FINGERPRINT_VERSION,
              source: `reviewer:${chunk.name}`,
              status: "proposed",
            });
            break;
          }
          case "ask_question":
            if (!questions.some((q) => q.body === out.value.body)) questions.push(out.value);
            break;
          case "note_needs_human":
            if (!needsHuman.some((n) => JSON.stringify(n) === JSON.stringify(out.value))) needsHuman.push(out.value);
            break;
          case "note_checked":
            checked.push(out.value.item);
            break;
          case "note_not_run":
            notRun.push(out.value.item);
            break;
        }
      }
    }
    if (chunks.length > 0 && reviewerOk === 0 && reviewerOutputs === 0) {
      throw new RunFailure(`the reviewer produced nothing: ${reviewerErrors.join("; ") || "no step could run within the spend cap"}`);
    }
    stage("04-review.json", { findings, questions, needsHuman, checked, notRun, partial });

    // ---- S-5 verify -------------------------------------------------------
    findings = groundFindings(findings, { diff: indexDiff(det.included), lookup });
    if (scope === "incremental") {
      // Inline comments anchor on the PR's own diff; a line the new commits
      // touch but the PR as a whole does not cannot carry one.
      findings = findings.map((f) => {
        const a = f.locations[0]!;
        if (!isLive(f) || f.tag === "pre-existing" || isInDiff(fullIndex, a.path, a.startLine, a.endLine)) return f;
        return { ...f, tag: "pre-existing", retaggedFrom: f.tag, statusReason: `anchor ${a.path}:${a.startLine} is outside the pull request's diff; re-tagged pre-existing from ${f.tag}` };
      });
    }
    // S-5: a fingerprint this bot already posted on the PR is not posted, or verified, again.
    findings = findings.map((f) =>
      isLive(f) && prior.fingerprints.has(f.fingerprint)
        ? { ...f, status: "duplicate" as const, statusReason: "already raised on this PR by this bot (same fingerprint)" }
        : f,
    );
    let verifierGaps = 0;
    for (const [i, f] of findings.entries()) {
      if (!isLive(f) || f.tag !== "important") continue;
      if (verifierModel === undefined) {
        findings[i] = { ...f, status: "unverified", statusReason: "not verified: no verifier model configured" };
        verifierGaps++;
        continue;
      }
      const prompt = `Finding to verify (reported by another reviewer; a claim, not a fact):\n\n\`\`\`json\n${JSON.stringify(producerPart(f), null, 2)}\n\`\`\`\n\nPaths in \`locations\` and in \`evidence\` with root \`head\` are relative to your working directory.\n`;
      const result = await step(`verify:${f.id}`, "verifier", verifierModel, {
        systemPrompt: method.verifier,
        prompt,
        roots: { head: heads.head, base: heads.base, ...(o.modcache === undefined ? {} : { modcache: o.modcache }) },
        outputTools: VERIFIER_TOOLS,
      });
      const verdict = result?.outputs.filter((x) => x.tool === "submit_verdict").map((x) => x.value as Verdict).pop();
      if (verdict === undefined) {
        const why = result === undefined ? "the run spend cap was reached" : `${result.outcome}${result.error ? `: ${result.error.message}` : ""}`;
        findings[i] = { ...f, status: "unverified", statusReason: `verifier returned no verdict (${why})` };
        verifierGaps++;
        continue;
      }
      const missing = verdict.verdict === "refuted" ? verdict.evidence.filter((e: Evidence) => !quoteFound(e, lookup)) : [];
      if (missing.length > 0) {
        // Drop only on proof (P-7): a refutation whose evidence is not where it says counts as inconclusive.
        findings[i] = {
          ...f,
          status: "unverified",
          statusReason: `verifier refuted it, but its evidence was not found at ${missing.map((e) => `${e.root}:${e.path}:${e.startLine}`).join(", ")}`,
          verdict,
        };
        continue;
      }
      findings[i] = applyVerdict(f, verdict);
    }
    if (verifierModel === undefined && verifierGaps > 0) notRun.push("Independent verification of Important findings: no verifier model is configured, so they are labelled unverified.");
    else if (verifierGaps > 0) notRun.push(`Independent verification did not complete for ${verifierGaps} Important finding(s); they are labelled unverified.`);

    // Earlier findings of this bot whose threads are still open (S-6, I-2 #9).
    const rechecks: RecheckOutcome[] = [];
    const newFingerprints = new Map(findings.filter((f) => f.status !== "refuted").map((f) => [f.fingerprint, f]));
    for (const p of priorOpen) {
      const base: Omit<RecheckOutcome, "status" | "detail" | "by"> = { commentId: p.commentId, fingerprint: p.fingerprint, title: p.title };
      if (p.tag !== undefined) base.tag = p.tag;
      const again = newFingerprints.get(p.fingerprint);
      if (again !== undefined) {
        const a = again.locations[0]!;
        rechecks.push({ ...base, status: "still-open", by: "fingerprint", detail: `The flagged code at \`${a.path}:${a.startLine}\` is unchanged, and this round found the same problem again.` });
        continue;
      }
      if (verifierModel === undefined) {
        rechecks.push({ ...base, status: "not-checked", by: "none", detail: "not re-checked: no verifier model is configured" });
        continue;
      }
      const result = await step(`recheck:${p.commentId}`, "verifier", verifierModel, {
        systemPrompt: method.recheck,
        prompt: recheckPrompt(p, sinceSha, pr.headSha, det),
        roots,
        outputTools: RECHECK_TOOLS,
      });
      const r = result?.outputs.filter((x) => x.tool === "submit_recheck").map((x) => x.value).pop() as Recheck | undefined;
      if (r === undefined || !isValidRecheck(r)) {
        const why = result === undefined ? "the run spend cap was reached" : result.outcome;
        rechecks.push({ ...base, status: "inconclusive", by: "model", detail: `could not be re-checked (${why})` });
        continue;
      }
      if (r.status === "fixed" && r.evidence.some((e) => !quoteFound(e, lookup))) {
        rechecks.push({ ...base, status: "inconclusive", by: "model", detail: "a fix was claimed, but the cited code was not found" });
        continue;
      }
      rechecks.push({ ...base, status: r.status, by: "model", detail: r.detail });
    }
    stage("05-verify.json", { findings, rechecks });
    log(`S-5 verify ok live=${findings.filter(isLive).length} refuted=${findings.filter((f) => f.status === "refuted").length} rechecks=${rechecks.length}`);

    // ---- S-6 reconcile ----------------------------------------------------
    findings = dedupeAgainstComments(findings, prior.othersInline);
    findings = reconcile(findings, { priorFingerprints: prior.fingerprints, nitCap: reviewMd.nitCap });
    stage("06-reconcile.json", { findings, rechecks });
    log(`S-6 reconcile ok publish=${findings.filter(isLive).length} duplicate=${findings.filter((f) => f.status === "duplicate").length} over-limit=${findings.filter((f) => f.status === "over-limit").length}`);

    // ---- S-7 publish ------------------------------------------------------
    if (knowledgeEditedByPr.length > 0) {
      notRun.push(`This PR edits ${knowledgeEditedByPr.map((p) => `\`${p}\``).join(", ")}; the review used the base branch's versions (C-3).`);
    }
    const preExisting = preExistingItems(findings);
    if (preExisting.length > 0) notRun.push("Issue tracker search: not available to the reviewer, so existing `tech-debt` issues were not checked.");
    const earlier = {
      stillOpen: rechecks
        .filter((r) => r.status !== "fixed")
        .map((r): EarlierFinding => ({ title: r.title, detail: r.status === "still-open" ? r.detail : `not confirmed fixed: ${r.detail}`, ...(r.tag ? { tag: r.tag } : {}) })),
      verifiedFixed: rechecks.filter((r) => r.status === "fixed").map((r): EarlierFinding => ({ title: r.title, detail: r.detail, ...(r.tag ? { tag: r.tag } : {}) })),
    };
    const partialText = partial.length > 0 ? `${partial.join("; ")}.` : undefined;
    const summary = renderSummary({
      round: { number: round, headSha: pr.headSha, ...(sinceSha === undefined ? {} : { sinceSha }) },
      counts: summaryCounts(findings),
      earlier,
      preExisting,
      questions,
      checked,
      notRun,
      ...(partialText === undefined ? {} : { partial: partialText }),
      needsHuman,
      marker: { kind: "summary", bot: botId, run: runId, sha: pr.headSha, fingerprintVersion: FINGERPRINT_VERSION },
    });
    const review = buildReview(pr.headSha, summary, findings, botId, runId);
    publication = {
      review,
      threadReplies: rechecks
        .filter((r) => r.status === "fixed" || (r.status === "still-open" && r.by !== "none"))
        .map((r) => ({ in_reply_to: numericId(r.commentId), body: recheckReplyBody(r.status as "fixed" | "still-open", pr!.headSha, r.detail) })),
      resolveThreads: rechecks
        .filter((r) => r.status === "fixed")
        .map((r) => ({ comment_id: numericId(r.commentId), reason: `verified fixed at ${short(pr!.headSha)}` })),
    };
    const counts = summaryCounts(findings);
    findings = findings.map((f) => (isLive(f) ? { ...f, status: "published" as const } : f));
    const result = await o.platform.publish(publication);
    published = true;
    const countText = `${counts.important} important, ${counts.nits} ${counts.nits === 1 ? "nit" : "nits"}, ${counts.preExisting} pre-existing`;
    if (partialText !== undefined) await complete("neutral", `Partial review of ${short(pr.headSha)} (${countText}): ${partialText}`);
    else await complete("success", `Reviewed ${short(pr.headSha)}${scope === "incremental" && sinceSha ? ` since ${short(sinceSha)}` : ""}: ${countText}.`);
    stage("07-publish.json", { publication, commentIds: result.commentIds, check: { name: botId, conclusion, summary: checkSummary } });
    publishedIds = result.commentIds;
    return await finish();
  } catch (e) {
    // ---- S-9 failure behaviour ---------------------------------------------
    const reason = e instanceof RunFailure && e.message === "cancelled" ? "the run was cancelled" : errorMessage(e);
    log(`run failed: ${reason}`);
    if (!published && pr !== undefined) {
      publication = { threadReplies: [], resolveThreads: [], failureComment: failureCommentBody(pr.headSha, reason) };
      try {
        await o.platform.publish(publication);
        published = true;
      } catch (pe) {
        log(`failure comment not published: ${errorMessage(pe)}`);
      }
    }
    await complete("neutral", `Review could not complete: ${reason}`);
    stage("07-publish.json", { publication: publication ?? null, check: { name: botId, conclusion, summary: checkSummary } });
    return await finish();
  }

  // ---- S-8 record ----------------------------------------------------------
  async function finish(): Promise<ReviewRunResult> {
    if (!checkCompleted) await complete(conclusion, checkSummary);
    const out: ReviewRunResult = { runId, conclusion, checkSummary };
    if (runDir !== undefined) out.runDir = runDir;
    if (publication !== undefined) out.publication = publication;
    try {
      const record = buildRecord();
      out.record = record;
      if (!Value.Check(RunRecord, record)) {
        const errors = [...Value.Errors(RunRecord, record)].slice(0, 5).map((x) => `${x.instancePath}: ${x.message}`);
        log(`S-8 record does not match the schema: ${errors.join("; ")}`);
      }
      if (runDir !== undefined) {
        out.recordPath = join(runDir, "08-record.json");
        writeFileSync(out.recordPath, JSON.stringify(record, null, 2) + "\n");
        log(`S-8 record ${out.recordPath}`);
      }
    } catch (e) {
      // Recording failures never affect the review (S-8).
      log(`S-8 record failed: ${errorMessage(e)}`);
    }
    return out;
  }

  function buildRecord(): RunRecord {
    const finishedAt = now();
    const roles: Record<string, string> = {};
    for (const [k, v] of Object.entries(config?.roles ?? {})) roles[k] = formatModel(v);
    const result: RunRecord["run"]["result"] = { checkConclusion: conclusion, summary: checkSummary, publishedCommentIds: publishedIds };
    if (skipReason !== undefined) result.skipReason = skipReason;
    return {
      tool: RUN_RECORD_TOOL,
      toolVersion: BOT_VERSION,
      repo: pr?.repo ?? "",
      generatedAt: finishedAt.toISOString(),
      metrics: runMetrics(findings, steps, Math.round(performance.now() - started)),
      findings,
      questions,
      needsHuman,
      run: {
        schemaVersion: RUN_RECORD_SCHEMA_VERSION,
        prNumber: pr?.number ?? 0,
        baseSha: pr?.baseSha ?? "",
        headSha: pr?.headSha ?? "",
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        trigger: o.trigger ?? "dry-run",
        scope,
        round,
        versions: {
          bot: BOT_VERSION,
          pi: PI_VERSION,
          methodSkillHash: method?.hash ?? "",
          knowledgeBaseSha: pr?.baseSha ?? "",
          fingerprintVersion: FINGERPRINT_VERSION,
          roles,
        },
        files,
        knowledgeFiles: knowledge === undefined ? [] : knowledgeFileList(knowledge),
        steps,
        result,
      },
    };
  }
}

function numericId(id: string): number | string {
  return /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : id;
}

function recheckPrompt(p: PriorFinding, sinceSha: string | undefined, headSha: string, det: DeterministicResult): string {
  const where = p.path ? `${p.path}${p.line !== undefined ? `:${p.startLine !== undefined && p.startLine !== p.line ? `${p.startLine}-` : ""}${p.line}` : " (the line is outdated; search for the code)"}` : "(no location)";
  const body = p.body
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("<!--"))
    .join("\n")
    .trim();
  const changed = det.patches.map((f) => `- \`${f.path}\`: \`${f.patchPath}\``).join("\n") || "(none)";
  return [
    `Earlier finding, posted at \`${where}\`:`,
    "",
    "<earlier-finding>",
    body.replace(/<\/?earlier-finding/gi, "&lt;earlier-finding"),
    "</earlier-finding>",
    "",
    `New head: \`${short(headSha)}\`${sinceSha ? `; commits since \`${short(sinceSha)}\` changed:` : "; files under review:"}`,
    changed,
    "",
    "Patches are in the inputs root. Decide whether the problem is fixed at the new head.",
  ].join("\n");
}

/**
 * S-6, against comments by anyone else (I-2 #9): a live finding whose anchor
 * lines carry an existing inline thread by a human or another bot is not
 * posted again. Mechanical and line-based; the reviewer also sees every
 * comment in context.md and is told not to repeat them.
 */
export function dedupeAgainstComments(findings: readonly Finding[], others: readonly PrComment[]): Finding[] {
  return findings.map((f) => {
    if (!isLive(f)) return f;
    const a = f.locations[0]!;
    const hit = others.find((c) => {
      if (c.path !== a.path || c.line === undefined) return false;
      const start = c.startLine ?? c.line;
      return start <= a.endLine && a.startLine <= c.line;
    });
    if (hit === undefined) return f;
    return { ...f, status: "duplicate", statusReason: `already raised by ${hit.author.login} in comment ${hit.id} at ${a.path}:${hit.line}` };
  });
}
