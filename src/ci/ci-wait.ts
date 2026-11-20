/**
 * Waiting for CI (C-9): which checks a head SHA must pass before it is
 * reviewed, and where they stand. Opt-in per repository with `ci.require`
 * in `.review/review-bot.yaml` on the base branch (or the gate's inputs).
 *
 * `evaluateCi` is pure; `collectCi` reads the facts from GitHub. Only the
 * configured names are looked at: check runs, commit statuses and workflow
 * runs that are not required are ignored, and every `ai-review/*` check is
 * left out, so two reviewers never wait for each other.
 */
import { formatDuration, parseDuration } from "../pipeline/index.ts";
import type { Github } from "./github.ts";

export const CI_ON_FAILURE = ["skip", "review"] as const;
export type CiOnFailure = (typeof CI_ON_FAILURE)[number];

export interface CiWaitConfig {
  /** `off`, `required` (base branch's required status checks), or names. */
  require: "off" | "required" | string[];
  onFailure: CiOnFailure;
  timeoutMs: number;
}

export const DEFAULT_CI_TIMEOUT_MS = 6 * 3_600_000;
export const DEFAULT_CI_WAIT: CiWaitConfig = { require: "off", onFailure: "skip", timeoutMs: DEFAULT_CI_TIMEOUT_MS };

/** Our own checks are never waited for (C-9: "minus every `ai-review/*` check"). */
export const OWN_CHECK_PREFIX = "ai-review/";

/** Conclusions that count as passed (C-9 gate table). */
const PASSED = new Set(["success", "skipped", "neutral"]);

/**
 * `ci.require` as text: `off`, `required`, or names separated by commas or
 * newlines. Throws on an empty list.
 */
export function parseCiRequire(text: string): CiWaitConfig["require"] {
  const t = text.trim();
  if (t === "" || t === "off") return "off";
  if (t === "required") return "required";
  const names = [...new Set(t.split(/[,\n]/).map((n) => n.trim()).filter((n) => n !== ""))];
  if (names.length === 0) return "off";
  return names;
}

/** `ci.timeout`: "6h", "90m", "3600" (seconds) or a number of seconds. */
export function parseCiTimeout(v: string | number): number {
  const ms = typeof v === "number" ? Math.round(v * 1000) : parseDuration(v);
  if (ms === undefined || !(ms > 0)) throw new Error(`invalid ci.timeout: ${String(v)} (e.g. 6h, 90m)`);
  return ms;
}

export function describeCiConfig(c: CiWaitConfig): string {
  if (c.require === "off") return "off";
  const what = c.require === "required" ? "the base branch's required checks" : c.require.join(", ");
  return `${what}; on failure ${c.onFailure}; timeout ${formatDuration(c.timeoutMs)}`;
}

// ---- facts ----------------------------------------------------------------

export interface CheckRunFact {
  name: string;
  status: string;
  conclusion: string | null;
  completedAt?: string;
}

export interface StatusFact {
  context: string;
  /** success, failure, error, pending */
  state: string;
  updatedAt?: string;
}

export interface WorkflowRunFact {
  id: number;
  /** The workflow's name. */
  name: string;
  status: string;
  conclusion: string | null;
  updatedAt?: string;
}

export interface CiFacts {
  checkRuns: CheckRunFact[];
  statuses: StatusFact[];
  /** Only read when a name matched no check run and no status. */
  workflowRuns: WorkflowRunFact[];
}

export interface CiState {
  state: "passed" | "failed" | "pending";
  required: string[];
  passed: string[];
  failed: string[];
  /** Pending or not yet reported. */
  pending: string[];
  /** Latest completion time among the required checks, once none is pending or one failed. */
  completedAt?: string;
}

type One = "passed" | "failed" | "pending";

function fromConclusion(status: string, conclusion: string | null): One {
  if (status !== "completed") return "pending";
  if (conclusion !== null && PASSED.has(conclusion)) return "passed";
  // A fork PR's run awaiting a maintainer's approval (C-9: the timeout covers it).
  if (conclusion === "action_required") return "pending";
  return "failed";
}

function fromStatus(state: string): One {
  if (state === "success") return "passed";
  if (state === "failure" || state === "error") return "failed";
  return "pending";
}

function later(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/** Names a fact list does not cover, so the workflow-runs API is only asked when needed. */
export function unmatchedNames(required: readonly string[], facts: Pick<CiFacts, "checkRuns" | "statuses">): string[] {
  return required.filter((n) => !facts.checkRuns.some((c) => c.name === n) && !facts.statuses.some((s) => s.context === n));
}

/**
 * Where the required checks stand on one SHA (C-9 gate table). A name may be
 * a check run, a status context or a workflow; every match counts. A name
 * with no match yet is pending. Any failure decides the whole as failed,
 * even while others are still pending.
 */
export function evaluateCi(required: readonly string[], facts: CiFacts): CiState {
  const names = [...new Set(required.filter((n) => !n.startsWith(OWN_CHECK_PREFIX)))];
  const out: CiState = { state: "passed", required: names, passed: [], failed: [], pending: [] };
  let completedAt: string | undefined;
  for (const name of names) {
    const results: One[] = [];
    for (const c of facts.checkRuns) {
      if (c.name !== name) continue;
      results.push(fromConclusion(c.status, c.conclusion));
      if (c.status === "completed") completedAt = later(completedAt, c.completedAt);
    }
    for (const s of facts.statuses) {
      if (s.context !== name) continue;
      results.push(fromStatus(s.state));
      if (s.state !== "pending") completedAt = later(completedAt, s.updatedAt);
    }
    // Several runs of one workflow on a SHA (re-runs, push and pull_request): the newest decides.
    const run = facts.workflowRuns.filter((w) => w.name === name).sort((a, b) => b.id - a.id)[0];
    if (run !== undefined) {
      results.push(fromConclusion(run.status, run.conclusion));
      if (run.status === "completed") completedAt = later(completedAt, run.updatedAt);
    }
    const r: One = results.length === 0 ? "pending" : results.includes("failed") ? "failed" : results.includes("pending") ? "pending" : "passed";
    out[r].push(name);
  }
  out.state = out.failed.length > 0 ? "failed" : out.pending.length > 0 ? "pending" : "passed";
  if (out.state !== "pending" && completedAt !== undefined) out.completedAt = completedAt;
  return out;
}

/**
 * The base branch's required status checks: classic branch protection
 * (from the branch, which any reader may fetch) and rulesets, minus every
 * `ai-review/*` check. A required check's expected app is not compared.
 */
export async function requiredChecks(gh: Github, branch: string): Promise<string[]> {
  const names = [...(await gh.getBranchRequiredChecks(branch)), ...(await gh.getRulesetRequiredChecks(branch))];
  return [...new Set(names)].filter((n) => !n.startsWith(OWN_CHECK_PREFIX)).sort();
}

/** The names `require` stands for on this PR. */
export async function resolveRequired(gh: Github, require: CiWaitConfig["require"], baseRef: string): Promise<string[]> {
  if (require === "off") return [];
  if (require === "required") return requiredChecks(gh, baseRef);
  return require.filter((n) => !n.startsWith(OWN_CHECK_PREFIX));
}

/** Reads the facts for `required` on `sha` and evaluates them. */
export async function collectCi(gh: Github, sha: string, required: readonly string[], log: (line: string) => void): Promise<CiState> {
  if (required.length === 0) return evaluateCi([], { checkRuns: [], statuses: [], workflowRuns: [] });
  const facts: CiFacts = { checkRuns: await gh.listCheckRuns(sha), statuses: await gh.listStatuses(sha), workflowRuns: [] };
  if (unmatchedNames(required, facts).length > 0) {
    try {
      facts.workflowRuns = await gh.listWorkflowRuns(sha);
    } catch (e) {
      // Without actions: read, workflow names cannot be matched; they stay pending.
      log(`could not list workflow runs (needs actions: read): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return evaluateCi(required, facts);
}

/** Up to `max` names, then "and N more". */
export function nameList(names: readonly string[], max = 10): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}
