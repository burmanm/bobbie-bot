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
import type { AgentStep, AgentStepResult, ModelRef, ModuleTool, OutputTool, QueryTool, ReadRoots } from "../agent/index.ts";
import { PI_VERSION, RUN_DEADLINE } from "../agent/index.ts";
import { scrubSecrets } from "../../pi-review/extension/query-tools.ts";
import { SAVED_SCRIPTS_FILE, ScriptCollector } from "../core/saved-scripts.ts";
import {
  applyVerdict,
  BOT_VERSION,
  type Evidence,
  type FileRecord,
  type Finding,
  FINGERPRINT_VERSION,
  fingerprintFinding,
  type HistorySource,
  groundFindings,
  indexDiff,
  isInDiff,
  isLive,
  type NeedsHumanNote,
  parseDiff,
  parseReviewMd,
  preExistingItems,
  areaNitCaps,
  type ReviewArea,
  producerPart,
  type Question,
  quoteFound,
  reconcile,
  renderSummary,
  safeSummary,
  RUN_RECORD_SCHEMA_VERSION,
  RUN_RECORD_TOOL,
  RunRecord,
  runMetrics,
  type StepRecord,
  summaryCounts,
  type Verdict,
  type WaitingInput,
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
import { type AgentSettings, modelsJsonSha256, NO_AGENT_SETTINGS, resolveRoleTools } from "./agent-settings.ts";
import { type InstalledPackage, SetupConfigError, verifyInstalled } from "../setup/index.ts";
import {
  CODEMODE,
  type ConfigInputs,
  ConfigError,
  type EnabledModel,
  formatDuration,
  formatModel,
  initialRunTimeoutMs,
  type ModelCatalog,
  type PipelineConfig,
  PIPELINE_ROLES,
  type PipelineRole,
  resolveConfig,
  resolveEnabledModels,
} from "./config.ts";
import { buildContext } from "./context.ts";
import { HISTORY_TOOL_NAMES, historyTools } from "./history-tools.ts";
import { type Chunk, chunkByDirectory, deterministicPass, type DeterministicResult } from "./deterministic.ts";
import { isKnowledgePath, type Knowledge, knowledgeFileList, type KnowledgeOverride, loadAreaReviews, loadKnowledge } from "./knowledge.ts";
import { snapshotLookup } from "./lookup.ts";
import { loadMethod, type Method } from "./method.ts";
import { buildReview, failureCommentBody, recheckReplyBody } from "./publish.ts";
import { derivePriorState, openPriorFindings, type PriorFinding, type PriorState } from "./prior.ts";
import { isValidRecheck, type Recheck, RECHECK_TOOLS, REVIEWER_TOOLS, VERIFIER_TOOLS } from "./tools.ts";
import { dependencyLabelNote, dependencyOnlySkip, type SkipDecision, skipBeforeDiff } from "./skip.ts";

export interface ReviewRunOptions {
  platform: Platform;
  snapshots: SnapshotSource;
  agentStep: AgentStep;
  /**
   * Workflow inputs / CLI flags: over the agent directory's settings, and
   * narrowed by `.review/review-bot.yaml` from base (F-7, C-2).
   */
  inputs: ConfigInputs;
  /**
   * The operator's agent directory (F-7), its `settings.json` already read
   * by the caller. Absent: no agent directory, so no settings and no
   * `enabledModels` (`NO_AGENT_SETTINGS`).
   */
  agent?: {
    dir: string;
    settings: AgentSettings;
    /**
     * pi's models with credentials, to resolve `enabledModels`
     * (src/agent/model-runtime.ts). Without it no model is enabled.
     */
    models?: () => Promise<ModelCatalog>;
  };
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
  /** The PR as the caller named it, so a record has an identity even when reading the PR fails (S-9). */
  prRef?: { repo: string; number: number };
  /**
   * Repository history and issue search for the model steps (S-4), served
   * through the code host's API. Without it the reviewer has neither and
   * the summary says so.
   */
  /**
   * What the CI gate knew about the wait (A-6 Waiting, C-9): recorded, and
   * a failed CI that was reviewed anyway (`ci.onFailure: review`) is said
   * in the summary.
   */
  waiting?: WaitingInput;
  history?: {
    source: HistorySource;
    /** Replay cutoff, read once the PR is known (E-2, `--head`). */
    asOf?: () => string | undefined;
  };
}

export interface ReviewRunResult {
  runId: string;
  runDir?: string;
  conclusion: CheckConclusion;
  checkSummary: string;
  publication?: Publication;
  record?: RunRecord;
  recordPath?: string;
  /** `scripts.json` next to the record, when a step ran a codemode script (A-6). */
  scriptsPath?: string;
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
/**
 * A role's read-only default (S-4, F-7): what `tools` in settings.json is
 * relative to. Output tools are added to whatever it resolves to.
 */
const ROLE_DEFAULT_TOOLS: readonly string[] = [...READ_TOOLS, ...HISTORY_TOOL_NAMES];
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
  let skipKind: SkipDecision["kind"] | undefined;
  let publication: Publication | undefined;
  let published = false;
  let checkCompleted = false;
  let spentUsd = 0;
  let publishedIds: string[] = [];
  /** Each role's tools as configured (F-7), before output tools; set with the config. */
  const roleTools: Partial<Record<PipelineRole, ReadonlySet<string>>> = {};
  let modelsJsonHash: string | undefined;
  /** The operator's packages, as installed (F-7, A-6); set once checked. */
  let installedPackages: InstalledPackage[] | undefined;
  /** Every codemode script the run's steps executed, scrubbed (A-6 `scripts.json`, F-7). */
  const savedScripts = new ScriptCollector(scrubSecrets);
  /** Tools from packages that were active in some step, for the summary (F-7). */
  const extraTools: ModuleTool[] = [];
  let partialNote: string | undefined;

  // Run deadline (S-4 Limits, S-9). One signal for the whole run: aborted
  // with the caller's reason on cancellation, or with RUN_DEADLINE when the
  // run's time is up. Steps stop on it; non-model stages race it. The
  // deadline comes from the inputs and settings first and is re-armed once
  // .review/review-bot.yaml is read, always measured from the run's start.
  const runController = new AbortController();
  const runSignal = runController.signal;
  const onOuterAbort = () => runController.abort(o.signal?.reason ?? "cancelled");
  if (o.signal?.aborted) onOuterAbort();
  else o.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const settings = o.agent?.settings ?? NO_AGENT_SETTINGS;
  let deadlineMs = initialRunTimeoutMs(o.inputs, settings);
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const armDeadline = (ms: number) => {
    deadlineMs = ms;
    clearTimeout(deadlineTimer);
    if (runSignal.aborted) return;
    const left = ms - (performance.now() - started);
    const fire = () => {
      if (runSignal.aborted) return;
      log(`run deadline of ${formatDuration(deadlineMs)} reached: stopping the running step; what exists is published as partial`);
      runController.abort(RUN_DEADLINE);
    };
    if (left <= 0) fire();
    else deadlineTimer = setTimeout(fire, left);
  };
  armDeadline(deadlineMs);
  const deadlineReached = () => runSignal.aborted && runSignal.reason === RUN_DEADLINE;
  /** Why a step was not run: the deadline or the spend cap. */
  let notRunWhy = "the run spend cap was reached";

  const stage = (file: string, data: unknown) => {
    if (runDir === undefined) return;
    writeFileSync(join(runDir, file), JSON.stringify(data, null, 2) + "\n");
  };
  /** A non-model stage, bounded by the run signal: a hung read cannot hold the run past its deadline. */
  const timed = async <T>(label: string, fn: () => Promise<T>, detail?: (r: T) => string): Promise<T> => {
    const t = performance.now();
    try {
      const r = await raceRun(label, fn());
      log(`${label} ok ${Math.round(performance.now() - t)}ms${detail ? ` ${detail(r)}` : ""}`);
      return r;
    } catch (e) {
      log(`${label} failed ${Math.round(performance.now() - t)}ms: ${errorMessage(e)}`);
      throw e;
    }
  };
  const checkCancelled = () => {
    if (deadlineReached()) throw new RunFailure(`the run deadline of ${formatDuration(deadlineMs)} was reached before the review started`);
    if (runSignal.aborted) throw new RunFailure("cancelled");
  };
  const raceRun = <T>(label: string, p: Promise<T>): Promise<T> => {
    if (runSignal.aborted) {
      p.catch(() => {});
      checkCancelled();
    }
    return new Promise<T>((resolvePromise, reject) => {
      const onAbort = () => {
        reject(
          new RunFailure(
            deadlineReached() ? `the run deadline of ${formatDuration(deadlineMs)} was reached during ${label}` : "cancelled",
          ),
        );
      };
      runSignal.addEventListener("abort", onAbort, { once: true });
      p.then(
        (v) => {
          runSignal.removeEventListener("abort", onAbort);
          resolvePromise(v);
        },
        (e: unknown) => {
          runSignal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
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
        // The record keeps the text as it is; GitHub renders this as Markdown (H-51).
        summary: safeSummary(summary),
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
    req: { systemPrompt: string; prompt: string; roots: ReadRoots; outputTools: readonly T[]; queryTools?: readonly QueryTool[] },
  ): Promise<AgentStepResult<T> | undefined> => {
    if (deadlineReached()) {
      notRunWhy = `the run deadline of ${formatDuration(deadlineMs)} was reached`;
      log(`${stepName} not run: ${notRunWhy}`);
      return undefined;
    }
    checkCancelled();
    const remaining = config!.limits.runCostUsd - spentUsd;
    if (remaining <= 0) {
      notRunWhy = "the run spend cap was reached";
      log(`${stepName} not run: run spend cap of $${config!.limits.runCostUsd} reached`);
      return undefined;
    }
    const roleLimits = config!.limits[role];
    const maxCostUsd = Math.min(roleLimits.maxCostUsd ?? Infinity, remaining);
    const tools = roleTools[role] ?? new Set(ROLE_DEFAULT_TOOLS);
    const queryTools = (req.queryTools ?? []).filter((t) => tools.has(t.name));
    const moduleTools = [...tools].filter((t) => !ROLE_DEFAULT_TOOLS.includes(t) && t !== CODEMODE);
    const codemode = tools.has(CODEMODE);
    let lastBeat = 0;
    const t = performance.now();
    const result = await o.agentStep.run({
      role,
      model,
      systemPrompt: req.systemPrompt,
      prompt: req.prompt,
      roots: req.roots,
      readTools: READ_TOOLS.filter((t) => tools.has(t)),
      outputTools: req.outputTools,
      ...(queryTools.length === 0 ? {} : { queryTools }),
      ...(moduleTools.length === 0 ? {} : { moduleTools }),
      ...(codemode
        ? {
            codemode: true,
            scripts: {
              record: (event) => savedScripts.record(stepName, event),
              scriptIdOf: (parent) => savedScripts.scriptIdOf(stepName, parent),
            },
          }
        : {}),
      limits: { ...roleLimits, maxCostUsd },
      signal: runSignal,
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
      ...(model.thinkingLevel === undefined ? {} : { thinkingLevel: model.thinkingLevel }),
      tools: result.harness.tools,
      ...(result.harness.moduleTools === undefined || result.harness.moduleTools.length === 0 ? {} : { moduleTools: result.harness.moduleTools }),
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
    if (result.providerRequests.length > 0) record.requests = result.providerRequests;
    for (const t of result.harness.moduleTools ?? []) {
      if (!extraTools.some((x) => x.tool === t.tool && x.source === t.source)) extraTools.push(t);
    }
    const err = result.error
      ? `${result.error.kind}: ${result.error.message}${result.stoppedBy ? ` (stopped by ${result.stoppedBy})` : ""}`
      : result.stoppedBy
        ? `stopped by ${result.stoppedBy}`
        : undefined;
    if (err !== undefined) record.error = err;
    steps.push(record);
    if (result.uncataloguedModel) {
      log(`${stepName}: model "${formatModel(model)}" is not in pi's offline catalog; used as a custom id (context window and output limit borrowed from another ${model.provider} model)`);
    }
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
    const agentDir = o.agent?.dir;
    if (agentDir !== undefined) modelsJsonHash = modelsJsonSha256(agentDir);
    // F-7, A-6: the listed packages as installed, checked offline before any
    // step loads them (files only; nothing is spawned). Each step checks
    // again against its own read roots.
    if (agentDir !== undefined && settings.packages.length > 0) {
      try {
        installedPackages = verifyInstalled({
          agentDir,
          packages: settings.packages,
          forbiddenRoots: [runDir!, ...(o.modcache === undefined ? [] : [resolve(o.modcache)])],
        });
      } catch (e) {
        if (e instanceof SetupConfigError) throw new ConfigError(e.message);
        throw e;
      }
      log(`S-1 packages ${installedPackages.map((p) => `${p.name}${p.version === undefined ? "" : `@${p.version}`}`).join(", ")}`);
    }
    // F-7: what the repository may pick, as pi resolves enabledModels; only
    // models with credentials match.
    let enabled: EnabledModel[] = [];
    const catalog = o.agent?.models;
    if (settings.enabledModels.length > 0 && catalog !== undefined) {
      const scope = await timed("S-1 enabled models", async () => resolveEnabledModels(settings, await catalog()), (r) => `${r.models.length}`);
      for (const w of scope.warnings) log(`S-1 enabledModels: ${w}`);
      enabled = scope.models;
    }
    config = resolveConfig(o.inputs, knowledge.botConfig?.text, settings, enabled);
    if (config.limits.runTimeoutMs !== deadlineMs) armDeadline(config.limits.runTimeoutMs);
    for (const role of PIPELINE_ROLES) {
      const tools = resolveRoleTools(config.tools[role], ROLE_DEFAULT_TOOLS);
      // F-7: codemode is pi's (R-1a step 5b); other names are tools of the
      // listed packages, and each step refuses one that no loaded package
      // registers.
      const unknown = tools.filter((t) => !ROLE_DEFAULT_TOOLS.includes(t) && t !== CODEMODE);
      if (tools.includes(CODEMODE)) log(`S-1 codemode enabled for the ${role} role`);
      if (unknown.length > 0 && settings.packages.length === 0) {
        throw new ConfigError(`reviewBot.roles.${role}.tools in settings.json names ${unknown.join(", ")}, but no packages are listed; the bot offers ${ROLE_DEFAULT_TOOLS.join(", ")}`);
      }
      roleTools[role] = new Set(tools);
    }
    const prior: PriorState = derivePriorState(comments, botId);
    round = prior.rounds + 1;

    // S-1 skip conditions (skip.ts); the deps-only one needs the diff and comes after it.
    let skip: SkipDecision | undefined = skipBeforeDiff(pr, config.skip, {
      hasReviewMd: knowledge.review !== undefined,
      lastReviewedSha: prior.lastReviewedSha,
    });

    let sinceSha: string | undefined;
    let reviewDiffText: string | undefined;
    let fullDiffText: string | undefined;
    if (skip === undefined) {
      fullDiffText = await timed("S-1 diff", () => o.platform.getDiff(), (d) => `${d?.length ?? 0} bytes`);
      if (fullDiffText === undefined) throw new RunFailure("the platform returned no diff");
      const fullParsed = parseDiff(fullDiffText);
      skip = dependencyOnlySkip(pr, fullParsed, config.skip);
      const depsNote = skip === undefined ? dependencyLabelNote(pr, fullParsed, config.skip) : undefined;
      if (depsNote !== undefined) log(`S-1 ${depsNote}`);
    }
    if (skip === undefined) {
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
      skipReason = skip.reason;
      skipKind = skip.kind;
      log(`S-1 skipped (${skip.kind}): ${skip.reason}`);
      await complete("skipped", `Skipped: ${skip.reason}.`);
      return await finish();
    }

    const reviewerModel = config.roles.reviewer;
    if (reviewerModel === undefined) {
      throw new ConfigError(
        "no model is configured for the reviewer role (set reviewBot.roles.reviewer.model in the agent directory's settings.json, or --model reviewer=<provider>/<id>)",
      );
    }
    const verifierModel = config.roles.verifier;
    await timed("S-1 head snapshot", () => o.snapshots.extract("head", currentPr.headSha, heads.head));
    checkCancelled();

    // ---- S-2 deterministic pass ------------------------------------------
    const reviewMd = parseReviewMd(knowledge.review!.text);
    const reviewFiles = parseDiff(reviewDiffText!);
    const fullFiles = scope === "incremental" ? parseDiff(fullDiffText!) : reviewFiles;
    // Per-area REVIEW.md files above any file the PR changes (A-5).
    loadAreaReviews(knowledge, [...new Set(fullFiles.flatMap((f) => [f.newPath, f.oldPath]).filter((p): p is string => p !== undefined))]);
    const areas: ReviewArea[] = [
      { dir: "", path: "REVIEW.md", parsed: reviewMd },
      ...knowledge.areas.map((f) => ({ dir: f.path.slice(0, -"/REVIEW.md".length), path: f.path, parsed: parseReviewMd(f.text) })),
    ];
    const det: DeterministicResult = deterministicPass(reviewFiles, areas, inputsDir);
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
      areaReviewMd: areas.slice(1).map((a) => ({
        path: a.path,
        appliesTo: `${a.dir}/`,
        skipEntries: a.parsed.skipEntries,
        nitCap: a.parsed.nitCap,
        unparsedSkipItems: a.parsed.unparsedSkipItems,
      })),
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
      areas,
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
    const asOf = o.history?.asOf?.();
    const queryTools: QueryTool[] =
      o.history === undefined
        ? []
        : historyTools({ source: o.history.source, headSha: pr.headSha, baseSha: pr.baseSha, ...(asOf === undefined ? {} : { asOf }) });
    let issueSearchOffered = false;

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
        queryTools,
      });
      if (result === undefined) {
        partial.push(`the reviewer step for ${chunk.name === "all" ? "the change" : chunk.name} was not run: ${notRunWhy}`);
        continue;
      }
      if (result.harness.tools.includes("search_issues")) issueSearchOffered = true;
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
              // A-6: reported from inside a saved codemode script.
              ...(out.scriptId === undefined ? {} : { scriptId: out.scriptId }),
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
      throw new RunFailure(`the reviewer produced nothing: ${reviewerErrors.join("; ") || `no step could run (${notRunWhy})`}`);
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
      const prompt = `Finding to verify (reported by another reviewer; a claim, not a fact):\n\n\`\`\`json\n${JSON.stringify(producerPart(f), null, 2)}\n\`\`\`\n\nPaths in \`locations\` and in \`evidence\` with root \`head\` are relative to the head read root.\n`;
      const result = await step(`verify:${f.id}`, "verifier", verifierModel, {
        systemPrompt: method.verifier,
        prompt,
        roots: { head: heads.head, base: heads.base, ...(o.modcache === undefined ? {} : { modcache: o.modcache }) },
        outputTools: VERIFIER_TOOLS,
        queryTools,
      });
      const verdict = result?.outputs.filter((x) => x.tool === "submit_verdict").map((x) => x.value as Verdict).pop();
      if (verdict === undefined) {
        const why =
          result === undefined
            ? notRunWhy
            : result.stoppedBy === "deadline"
              ? `the run deadline of ${formatDuration(deadlineMs)} was reached`
              : `${result.outcome}${result.error ? `: ${result.error.message}` : ""}`;
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
        queryTools,
      });
      const r = result?.outputs.filter((x) => x.tool === "submit_recheck").map((x) => x.value).pop() as Recheck | undefined;
      if (r === undefined || !isValidRecheck(r)) {
        const why = result === undefined ? notRunWhy : result.stoppedBy === "deadline" ? "the run deadline was reached" : result.outcome;
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
    findings = reconcile(findings, { priorFingerprints: prior.fingerprints, nitCaps: areaNitCaps(areas) });
    stage("06-reconcile.json", { findings, rechecks });
    log(`S-6 reconcile ok publish=${findings.filter(isLive).length} duplicate=${findings.filter((f) => f.status === "duplicate").length} over-limit=${findings.filter((f) => f.status === "over-limit").length}`);

    // ---- S-7 publish ------------------------------------------------------
    if (knowledgeEditedByPr.length > 0) {
      notRun.push(`This PR edits ${knowledgeEditedByPr.map((p) => `\`${p}\``).join(", ")}; the review used the base branch's versions (C-3).`);
    }
    const preExisting = preExistingItems(findings);
    if (preExisting.length > 0 && !issueSearchOffered) {
      notRun.push("Issue tracker search: not available to the reviewer, so existing `tech-debt` issues were not checked.");
    }
    const earlier = {
      stillOpen: rechecks
        .filter((r) => r.status !== "fixed")
        .map((r): EarlierFinding => ({ title: r.title, detail: r.status === "still-open" ? r.detail : `not confirmed fixed: ${r.detail}`, ...(r.tag ? { tag: r.tag } : {}) })),
      verifiedFixed: rechecks.filter((r) => r.status === "fixed").map((r): EarlierFinding => ({ title: r.title, detail: r.detail, ...(r.tag ? { tag: r.tag } : {}) })),
    };
    if (deadlineReached()) {
      partial.unshift(`the run deadline of ${formatDuration(deadlineMs)} was reached, so the review stopped early and later steps were not run`);
    }
    const partialText = partial.length > 0 ? `${partial.join("; ")}.` : undefined;
    partialNote = partialText;
    const summary = renderSummary({
      repo: pr.repo,
      round: { number: round, headSha: pr.headSha, ...(sinceSha === undefined ? {} : { sinceSha }) },
      counts: summaryCounts(findings),
      earlier,
      preExisting,
      questions,
      checked,
      notRun,
      ...(partialText === undefined ? {} : { partial: partialText }),
      ...(ciNote(o.waiting) === undefined ? {} : { ci: ciNote(o.waiting)! }),
      needsHuman,
      ...(extraTools.length === 0 ? {} : { extraTools }),
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
    if (deadlineReached()) partialNote = `the run deadline of ${formatDuration(deadlineMs)} was reached`;
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
    clearTimeout(deadlineTimer);
    o.signal?.removeEventListener("abort", onOuterAbort);
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
    try {
      // A-6: next to the record, uploaded with it. Compact JSON: the size cap is measured on it.
      const scripts = savedScripts.file();
      if (scripts !== undefined && runDir !== undefined) {
        out.scriptsPath = join(runDir, SAVED_SCRIPTS_FILE);
        writeFileSync(out.scriptsPath, JSON.stringify(scripts) + "\n");
        log(`S-8 scripts ${out.scriptsPath}: ${scripts.scripts.length} saved${scripts.droppedScripts > 0 ? `, ${scripts.droppedScripts} over the size cap` : ""}`);
      }
    } catch (e) {
      log(`S-8 scripts failed: ${errorMessage(e)}`);
    }
    return out;
  }

  function buildRecord(): RunRecord {
    const finishedAt = now();
    const roles: Record<string, string> = {};
    const thinking: Record<string, string> = {};
    for (const [k, v] of Object.entries(config?.roles ?? {})) {
      roles[k] = formatModel(v);
      thinking[k] = v.thinkingLevel ?? "off";
    }
    const tools: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(roleTools)) tools[k] = [...v];
    const result: RunRecord["run"]["result"] = { checkConclusion: conclusion, summary: checkSummary, publishedCommentIds: publishedIds };
    if (skipReason !== undefined) result.skipReason = skipReason;
    if (skipKind !== undefined) result.skipKind = skipKind;
    if (partialNote !== undefined) result.partial = partialNote;
    if (deadlineReached()) result.deadlineReached = true;
    return {
      tool: RUN_RECORD_TOOL,
      toolVersion: BOT_VERSION,
      repo: pr?.repo ?? o.prRef?.repo ?? "",
      generatedAt: finishedAt.toISOString(),
      metrics: runMetrics(findings, steps, Math.round(performance.now() - started)),
      findings,
      questions,
      needsHuman,
      run: {
        schemaVersion: RUN_RECORD_SCHEMA_VERSION,
        prNumber: pr?.number ?? o.prRef?.number ?? 0,
        baseSha: pr?.baseSha ?? "",
        headSha: pr?.headSha ?? "",
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        trigger: o.trigger ?? "dry-run",
        scope,
        round,
        ...(o.waiting === undefined ? {} : { waiting: { ...o.waiting, reviewStartedAt: startedAt.toISOString() } }),
        versions: {
          bot: BOT_VERSION,
          pi: PI_VERSION,
          methodSkillHash: method?.hash ?? "",
          knowledgeBaseSha: pr?.baseSha ?? "",
          fingerprintVersion: FINGERPRINT_VERSION,
          roles,
          thinking,
          tools,
          ...(modelsJsonHash === undefined ? {} : { modelsJsonSha256: modelsJsonHash }),
          ...(installedPackages === undefined ? {} : { packages: installedPackages }),
        },
        files,
        knowledgeFiles: knowledge === undefined ? [] : knowledgeFileList(knowledge),
        steps,
        result,
      },
    };
  }
}

/** C-9: the summary line about CI, when the review did not wait for it to pass. */
export function ciNote(w: WaitingInput | undefined): string | undefined {
  if (w === undefined) return undefined;
  if (w.ci === "failed") {
    return `CI failed (${(w.failed ?? []).join(", ") || "required checks"}); reviewed anyway because the repository sets \`ci.onFailure: review\`.`;
  }
  if (w.ci === "unavailable") return "The required CI checks could not be read, so this review did not wait for them.";
  return undefined;
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
