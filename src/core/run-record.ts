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
  // Versions
  versions: Type.Object({
    bot: Type.String(),
    pi: Type.String(),
    methodSkillHash: Type.String(),
    knowledgeBaseSha: Type.String(),
    fingerprintVersion: Type.Integer({ minimum: 1 }),
    roles: Type.Record(Type.String(), Type.String(), { description: "role -> model, as configured" }),
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
