/**
 * Run record (A-6, P-5), wrapped in the review process's shared report
 * envelope (`tool`, `toolVersion`, `repo`, `generatedAt`, `metrics`,
 * `findings`; maintenance-agents §6). Run-specific data lives in `run`;
 * questions and needs-human notes sit beside `findings`.
 *
 * The record holds no file contents (repo + SHAs are enough to re-fetch).
 */
import { Type, type Static } from "typebox";
import { AskQuestionParams, Finding, NoteNeedsHumanParams } from "./schemas.ts";

export const RUN_RECORD_TOOL = "review-bot";
export const RUN_RECORD_SCHEMA_VERSION = 1;

export const STEP_OUTCOMES = ["ok", "timeout", "error", "truncated", "cancelled"] as const;
export type StepOutcome = (typeof STEP_OUTCOMES)[number];

export const StepRecord = Type.Object({
  name: Type.String({ description: 'e.g. "review", "verify:<finding id>"' }),
  role: Type.Enum(["reviewer", "verifier", "learner"] as const),
  configuredModel: Type.String({ description: "provider/id as configured for the role" }),
  /** pi's thinking level for the step; absent is "off" (F-7, A-6). */
  thinkingLevel: Type.Optional(Type.String()),
  /** Tools declared to the model in this step (A-6, F-7). */
  tools: Type.Optional(Type.Array(Type.String())),
  servedModels: Type.Array(Type.String(), { description: "responseModel ?? model, distinct" }),
  outcome: Type.Enum(STEP_OUTCOMES),
  error: Type.Optional(Type.String()),
  usage: Type.Object({
    turns: Type.Integer({ minimum: 0 }),
    input: Type.Integer({ minimum: 0 }),
    output: Type.Integer({ minimum: 0 }),
    cacheRead: Type.Integer({ minimum: 0 }),
    cacheWrite: Type.Integer({ minimum: 0 }),
    costUsd: Type.Number({ minimum: 0 }),
    costIsBilled: Type.Boolean({ description: "false when any part is a catalog estimate" }),
    wallMs: Type.Integer({ minimum: 0 }),
  }),
  /** Aborted model calls report zero usage, so a timed-out step under-reports (A-6). */
  usageComplete: Type.Boolean(),
  rejectedCalls: Type.Array(Type.Object({ tool: Type.String(), reason: Type.String() })),
  /**
   * What was sent to the provider, one entry per model call: model, counts,
   * settings, body size and hash; never message text or the key (A-6).
   * Absent when the provider does not report the request body.
   */
  requests: Type.Optional(
    Type.Array(
      Type.Object({
        model: Type.Optional(Type.String()),
        messages: Type.Optional(Type.Integer({ minimum: 0 })),
        toolCount: Type.Optional(Type.Integer({ minimum: 0 })),
        toolNames: Type.Optional(Type.Array(Type.String())),
        maxTokens: Type.Optional(Type.Number()),
        temperature: Type.Optional(Type.Number()),
        reasoning: Type.Optional(Type.String()),
        routing: Type.Optional(Type.String()),
        bytes: Type.Integer({ minimum: 0 }),
        sha256: Type.String(),
      }),
    ),
  ),
});
export type StepRecord = Static<typeof StepRecord>;

export const FileRecord = Type.Object({
  path: Type.String(),
  oldPath: Type.Optional(Type.String()),
  status: Type.Enum(["added", "deleted", "modified", "renamed", "copied"] as const),
  binary: Type.Boolean(),
  excluded: Type.Optional(Type.String({ description: "Reason the file was not reviewed" })),
});
export type FileRecord = Static<typeof FileRecord>;

const ISO_TIME = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$";
const CheckName = Type.String({ minLength: 1, maxLength: 200, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });

/**
 * What the gate knew about the wait before this review (A-6 Waiting, C-9),
 * as it hands it to the review job. Input to the queue-time metrics (O-1):
 * head seen → CI completed is the CI wait; CI completed (or head seen) →
 * `reviewStartedAt` is the rest, runner wait included.
 */
export const WaitingInput = Type.Object(
  {
    /** When the bot first saw the head SHA (the queued check's start, else the gate's time). */
    headSeenAt: Type.String({ pattern: ISO_TIME }),
    /**
     * passed / failed: required CI completed; not-required; ignored (dispatch
     * with ignore-ci); unavailable (could not be read); timed-out: CI did not
     * report within ci.timeout (only in a gate record, C-9).
     */
    ci: Type.Enum(["passed", "failed", "not-required", "ignored", "unavailable", "timed-out"] as const),
    required: Type.Optional(Type.Array(CheckName, { maxItems: 100 })),
    failed: Type.Optional(Type.Array(CheckName, { maxItems: 100 })),
    /** When the last required check completed. */
    ciCompletedAt: Type.Optional(Type.String({ pattern: ISO_TIME })),
    /** The event that resumed a waiting review: workflow_run, status, schedule. */
    resumedBy: Type.Optional(Type.Enum(["workflow_run", "status", "schedule"] as const)),
  },
  { additionalProperties: false },
);
export type WaitingInput = Static<typeof WaitingInput>;

export const Waiting = Type.Object(
  {
    ...WaitingInput.properties,
    reviewStartedAt: Type.Optional(Type.String({ description: "When this review run started (= run.startedAt); absent in a gate record, where no review ran" })),
  },
  { additionalProperties: false },
);
export type Waiting = Static<typeof Waiting>;

export const RunInfo = Type.Object({
  schemaVersion: Type.Literal(RUN_RECORD_SCHEMA_VERSION),
  // Identity
  prNumber: Type.Integer({ minimum: 1 }),
  baseSha: Type.String(),
  headSha: Type.String(),
  runId: Type.String(),
  startedAt: Type.String(),
  finishedAt: Type.Optional(Type.String()),
  trigger: Type.String(),
  scope: Type.Enum(["full", "incremental"] as const),
  round: Type.Integer({ minimum: 1 }),
  /** A-6 Waiting: absent when the run was not started by the CI gate (local runs). */
  waiting: Type.Optional(Waiting),
  // Versions
  versions: Type.Object({
    bot: Type.String(),
    pi: Type.String(),
    methodSkillHash: Type.String(),
    knowledgeBaseSha: Type.String(),
    fingerprintVersion: Type.Integer({ minimum: 1 }),
    roles: Type.Record(Type.String(), Type.String(), { description: "role -> model, as configured" }),
    /** role -> pi thinking level, as configured (F-7). */
    thinking: Type.Optional(Type.Record(Type.String(), Type.String())),
    /** role -> configured tools before output tools, as resolved from settings.json (F-7). */
    tools: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
    /** SHA-256 of the agent directory's models.json, when there is one (F-7). */
    modelsJsonSha256: Type.Optional(Type.String()),
  }),
  // Inputs
  files: Type.Array(FileRecord),
  knowledgeFiles: Type.Array(Type.String()),
  // Steps
  steps: Type.Array(StepRecord),
  // Result
  result: Type.Object({
    checkConclusion: Type.Enum(["success", "skipped", "neutral"] as const),
    summary: Type.String({ description: "One-line check-run summary" }),
    publishedCommentIds: Type.Array(Type.String()),
    skipReason: Type.Optional(Type.String()),
    /** Which S-1 condition skipped the run: not-onboarded, draft, opt-out, round-cap, label, deps-only, already-reviewed. */
    skipKind: Type.Optional(Type.String()),
    /** Why the review is partial (S-9), as stated in the summary. */
    partial: Type.Optional(Type.String()),
    /** The whole-run deadline stopped the run (S-4 Limits). */
    deadlineReached: Type.Optional(Type.Boolean()),
  }),
});
export type RunInfo = Static<typeof RunInfo>;

export const RunRecord = Type.Object({
  tool: Type.Literal(RUN_RECORD_TOOL),
  toolVersion: Type.String(),
  repo: Type.String({ description: "owner/name" }),
  generatedAt: Type.String(),
  metrics: Type.Object({
    findings: Type.Integer({ minimum: 0 }),
    published: Type.Integer({ minimum: 0 }),
    important: Type.Integer({ minimum: 0 }),
    nits: Type.Integer({ minimum: 0 }),
    preExisting: Type.Integer({ minimum: 0 }),
    costUsd: Type.Number({ minimum: 0 }),
    costUsdCompleteStepsOnly: Type.Number({ minimum: 0 }),
    stepsWithIncompleteUsage: Type.Integer({ minimum: 0 }),
    wallMs: Type.Integer({ minimum: 0 }),
  }),
  findings: Type.Array(Finding, { description: "All findings, including dropped ones, with status and statusReason" }),
  questions: Type.Array(AskQuestionParams),
  needsHuman: Type.Array(NoteNeedsHumanParams),
  run: RunInfo,
});
export type RunRecord = Static<typeof RunRecord>;

/** Which gate decision ended a run without a review (`result.skipKind` of a gate record). */
export const GATE_END_KINDS = ["not-authorized", "ci-failed", "ci-timeout", "superseded", "stale-in-progress"] as const;
export type GateEndKind = (typeof GATE_END_KINDS)[number];

export interface GateRecordInput {
  repo: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  runId: string;
  /** The event that ran the gate: pull_request_target, workflow_run, status, schedule, workflow_dispatch. */
  trigger: string;
  startedAt: Date;
  finishedAt: Date;
  conclusion: "skipped" | "neutral";
  /** The check run's title and summary as written. */
  summary: string;
  kind: GateEndKind;
  piVersion: string;
  botVersion: string;
  fingerprintVersion: number;
  waiting?: WaitingInput;
}

/**
 * The run record for a check the gate completed itself (R-2 exit: every run
 * leaves a record). No model step ran and no file was read, so steps, files,
 * findings and the method hash are empty; the knowledge SHA is the base, which
 * the gate read `.review/review-bot.yaml` from (A-5).
 */
export function gateRunRecord(o: GateRecordInput): RunRecord {
  const run: RunInfo = {
    schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    prNumber: o.prNumber,
    baseSha: o.baseSha,
    headSha: o.headSha,
    runId: o.runId,
    startedAt: o.startedAt.toISOString(),
    finishedAt: o.finishedAt.toISOString(),
    trigger: o.trigger,
    scope: "full",
    round: 1,
    versions: { bot: o.botVersion, pi: o.piVersion, methodSkillHash: "", knowledgeBaseSha: o.baseSha, fingerprintVersion: o.fingerprintVersion, roles: {} },
    files: [],
    knowledgeFiles: [],
    steps: [],
    result: { checkConclusion: o.conclusion, summary: o.summary, publishedCommentIds: [], skipReason: o.summary, skipKind: o.kind },
  };
  if (o.waiting !== undefined) run.waiting = { ...o.waiting };
  return {
    tool: RUN_RECORD_TOOL,
    toolVersion: o.botVersion,
    repo: o.repo,
    generatedAt: o.finishedAt.toISOString(),
    metrics: runMetrics([], [], Math.max(0, o.finishedAt.getTime() - o.startedAt.getTime())),
    findings: [],
    questions: [],
    needsHuman: [],
    run,
  };
}

/** Compute envelope metrics from findings and steps. */
export function runMetrics(findings: readonly Finding[], steps: readonly StepRecord[], wallMs: number): RunRecord["metrics"] {
  const live = findings.filter((f) => f.status === "published");
  let cost = 0;
  let costComplete = 0;
  let incomplete = 0;
  for (const s of steps) {
    cost += s.usage.costUsd;
    if (s.usageComplete) costComplete += s.usage.costUsd;
    else incomplete++;
  }
  return {
    findings: findings.length,
    published: live.length,
    important: live.filter((f) => f.tag === "important").length,
    nits: live.filter((f) => f.tag === "nit").length,
    preExisting: live.filter((f) => f.tag === "pre-existing").length,
    costUsd: cost,
    costUsdCompleteStepsOnly: costComplete,
    stepsWithIncompleteUsage: incomplete,
    wallMs,
  };
}
