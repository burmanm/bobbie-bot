/**
 * The `gate` job (C-4): decides whether this PR event gets an automatic
 * review. It holds no model key, runs nothing from the PR and reads only
 * GitHub API data.
 *
 * Who is reviewed automatically:
 * - The author has write access or above (admin, maintain, write), checked
 *   through the permissions API → reviewed on open and on every push.
 * - Anyone else → only while the authorization label is on the PR and was
 *   applied by someone with write access. Default label
 *   `ai-review/approved`; lifetime `per-push` (removed on the author's next
 *   push, so approval covers the commits the maintainer looked at) or
 *   `per-pr` (kept) — Q-10.
 * - A manual dispatch counts as a maintainer's request (dispatching needs
 *   write access; the gate checks it again).
 *
 * Not authorized → the gate completes `ai-review/<name>` as *skipped* with
 * the reason. Events that change nothing (an unrelated label, a closed PR)
 * are ignored: no check, no review.
 *
 * Waiting for CI (C-9), after authorization: when `ci.require` is set, the
 * required checks on the head SHA decide — passed → review; failed →
 * `ci.onFailure` (skip, or review and say so); pending → `ai-review/<name>`
 * is created *queued* ("Waiting for CI: …") and the gate stops. A queued
 * check is resumed by `workflow_run` / `status` events and by the scheduled
 * sweep (`runResume`), which also ends it when CI fails, when CI does not
 * report within `ci.timeout`, or when a newer push supersedes it. A queued
 * check therefore always ends as success, skipped or neutral (I-2 #1).
 */
import { parseBotConfigYaml } from "../pipeline/index.ts";
import {
  type CiState,
  type CiWaitConfig,
  collectCi,
  DEFAULT_CI_WAIT,
  describeCiConfig,
  nameList,
  parseCiRequire,
  parseCiTimeout,
  resolveRequired,
} from "./ci-wait.ts";
import { formatDuration } from "../pipeline/index.ts";
import type { CheckRunOutput, CheckRunSummary, Github, PullSummary } from "./github.ts";
import type { GateEndKind } from "../core/index.ts";

export const DEFAULT_AUTH_LABEL = "ai-review/approved";
export const LIFETIMES = ["per-push", "per-pr"] as const;
export type LabelLifetime = (typeof LIFETIMES)[number];

/** `pull_request_target` actions the reference workflow subscribes to (C-2). */
export const REVIEW_ACTIONS = ["opened", "reopened", "ready_for_review", "synchronize", "labeled"] as const;

/**
 * Events that resume a PR waiting for CI (C-9). They run the default
 * branch's workflow and name no PR (`workflow_run.pull_requests` is empty
 * for forks), so the gate finds the PR itself by head SHA.
 */
export const RESUME_EVENTS = ["workflow_run", "status", "schedule"] as const;

export function isResumeEvent(name: string): boolean {
  return (RESUME_EVENTS as readonly string[]).includes(name);
}

export interface GateConfig {
  /** Reviewer name; the check run is `ai-review/<name>`. */
  name: string;
  label: string;
  lifetime: LabelLifetime;
  /** C-9; off unless configured. */
  ci: CiWaitConfig;
}

export interface GateEvent {
  /** `pull_request_target`, `workflow_dispatch`, or a resume event; anything else is ignored. */
  name: string;
  /** The `pull_request_target` action. */
  action?: string;
  /** `labeled`: the label that was applied. */
  label?: string;
  /** Who triggered the event: labeler, pusher, dispatcher. */
  sender: string;
  /** Absent for resume events. */
  prNumber?: number;
  /**
   * The PR head SHA in the event payload (what the labeler saw); for
   * `workflow_run` and `status`, the commit the CI result is for.
   */
  headSha?: string;
  /** `synchronize`: the previous head, whose queued check the push supersedes. */
  before?: string;
  /** `workflow_dispatch` with `ignore-ci`: review without waiting for CI. */
  ignoreCi?: boolean;
}

export interface GateFacts {
  pr: PullSummary;
  authorIsMaintainer: boolean;
  /** Looked up for `labeled` and `workflow_dispatch` only. */
  senderIsMaintainer?: boolean;
  /** Who applied the authorization label most recently, when it is on the PR. */
  labelApplier?: { login: string; isMaintainer: boolean };
}

export type GateDecision =
  | { kind: "review"; via: "maintainer" | "label" | "dispatch"; reason: string }
  /** Complete the check as skipped; optionally remove a stale or unauthorized label. */
  | { kind: "skip"; reason: string; removeLabel: boolean; title?: string }
  /** C-9: the check is queued until the required CI completes. */
  | { kind: "wait"; reason: string }
  /** Do nothing at all: no check, no review. */
  | { kind: "ignore"; reason: string };

/** Which facts `decide` needs, so the gate only makes the API calls that matter. */
export function needs(event: GateEvent): { sender: boolean } {
  return { sender: event.name === "workflow_dispatch" || (event.name === "pull_request_target" && event.action === "labeled") };
}

/** The authorization rules (C-4, Q-10). Pure. */
export function decide(event: GateEvent, config: GateConfig, facts: GateFacts): GateDecision {
  const { pr } = facts;
  const label = config.label;
  if (pr.state !== "open") return { kind: "ignore", reason: `#${pr.number} is closed` };

  if (event.name === "workflow_dispatch") {
    if (facts.senderIsMaintainer !== true) return { kind: "ignore", reason: `dispatched by ${event.sender}, who does not have write access` };
    return { kind: "review", via: "dispatch", reason: `requested by ${event.sender}` };
  }
  if (isResumeEvent(event.name)) {
    // C-9 resume: authorization is checked again, as on a push at the same head.
    if (facts.authorIsMaintainer) return { kind: "review", via: "maintainer", reason: `${pr.author.login} has write access` };
    const applier = facts.labelApplier;
    if (pr.labels.includes(label) && applier?.isMaintainer === true) return { kind: "review", via: "label", reason: `"${label}" applied by ${applier.login}` };
    return {
      kind: "skip",
      title: NOT_AUTHORIZED,
      reason: `${pr.author.login} does not have write access and the label "${label}" is no longer on the PR from a maintainer, so the review that waited for CI does not run`,
      removeLabel: false,
    };
  }
  if (event.name !== "pull_request_target") return { kind: "ignore", reason: `event ${event.name} is not a review trigger` };
  const action = event.action ?? "";
  if (!(REVIEW_ACTIONS as readonly string[]).includes(action)) return { kind: "ignore", reason: `action ${action} is not a review trigger` };

  if (action === "labeled") {
    if (event.label !== label) return { kind: "ignore", reason: `label "${event.label ?? ""}" is not the authorization label` };
    if (facts.authorIsMaintainer) return { kind: "ignore", reason: `${pr.author.login} has write access; the PR is reviewed on each push without the label` };
    if (facts.senderIsMaintainer !== true) {
      return {
        kind: "skip",
        reason: `the label "${label}" was applied by ${event.sender}, who does not have write access, so it does not authorize a review; it was removed`,
        removeLabel: true,
      };
    }
    if (event.headSha !== undefined && event.headSha !== pr.headSha) {
      return { kind: "ignore", reason: `the head moved after the label was applied (${short(event.headSha)} → ${short(pr.headSha)}); the push's own run decides` };
    }
    return { kind: "review", via: "label", reason: `"${label}" applied by ${event.sender}` };
  }

  if (facts.authorIsMaintainer) return { kind: "review", via: "maintainer", reason: `${pr.author.login} has write access` };

  const waiting = `${pr.author.login} does not have write access, so a maintainer reviews the changes and applies the label "${label}" to request an automatic review`;
  if (!pr.labels.includes(label)) return { kind: "skip", reason: waiting, removeLabel: false };
  if (config.lifetime === "per-push" && (action === "synchronize" || action === "reopened")) {
    const what = action === "synchronize" ? "new commits were pushed" : "the PR was reopened";
    return {
      kind: "skip",
      reason: `${what} after the label "${label}" was applied; approval covers one push, so the label was removed. ${capitalize(waiting)} again.`,
      removeLabel: true,
    };
  }
  const applier = facts.labelApplier;
  if (applier === undefined || !applier.isMaintainer) {
    return {
      kind: "skip",
      reason: `the label "${label}" was ${applier ? `applied by ${applier.login}, who does not have write access` : "not applied by anyone with write access"}, so it was removed. ${capitalize(waiting)}.`,
      removeLabel: true,
    };
  }
  return { kind: "review", via: "label", reason: `"${label}" applied by ${applier.login}` };
}

const NOT_AUTHORIZED = "Skipped: not authorized for automatic review";

function short(sha: string): string {
  return sha.slice(0, 7);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Inputs first, then `authorization` and `ci` from `.review/review-bot.yaml`
 * on the base SHA (A-5, C-2). The check name is never taken from the YAML:
 * the pipeline does not either (the check opens before the YAML is read).
 * An invalid YAML file keeps the input label but forces `per-push`, the
 * stricter lifetime, and keeps the input CI settings; the review itself
 * then reports the configuration error.
 */
export function resolveGateConfig(inputs: GateConfig, yamlText: string | undefined, warn: (line: string) => void): GateConfig {
  if (yamlText === undefined) return inputs;
  try {
    const y = parseBotConfigYaml(yamlText);
    const a = y.authorization;
    const label = a?.label !== undefined && a.label.trim() !== "" ? a.label.trim() : inputs.label;
    const ci: CiWaitConfig = { ...inputs.ci };
    if (y.ci?.require !== undefined) ci.require = Array.isArray(y.ci.require) ? parseCiRequire(y.ci.require.join("\n")) : y.ci.require;
    if (y.ci?.onFailure !== undefined) ci.onFailure = y.ci.onFailure;
    if (y.ci?.timeout !== undefined) ci.timeoutMs = parseCiTimeout(y.ci.timeout);
    return { name: inputs.name, label, lifetime: a?.lifetime ?? inputs.lifetime, ci };
  } catch (e) {
    warn(`${e instanceof Error ? e.message : String(e)}; using label "${inputs.label}" with lifetime per-push`);
    return { ...inputs, lifetime: "per-push" };
  }
}

/**
 * What the review job is told about the wait (A-6 Waiting, O-1), passed
 * through the workflow as one JSON line and validated again by the CLI.
 */
export interface WaitingInfo {
  /** When the bot first saw the head SHA: the queued check's start, else this gate. */
  headSeenAt: string;
  /** passed / failed: required CI completed; not-required: no wait configured; ignored: dispatch with ignore-ci; unavailable: could not be read. */
  ci: "passed" | "failed" | "not-required" | "ignored" | "unavailable" | "timed-out";
  required?: string[];
  failed?: string[];
  /** When the last required check completed. */
  ciCompletedAt?: string;
  /** The event that started the review: the push, or the CI result that resumed it. */
  resumedBy?: string;
}

/**
 * A check the gate completed itself, ending that head's run without a
 * review. Each becomes a gate run record (R-2 exit: every run leaves a record).
 */
export interface GateEnd {
  pr: Pick<PullSummary, "number" | "headSha" | "baseSha">;
  kind: GateEndKind;
  conclusion: "skipped" | "neutral";
  output: CheckRunOutput;
  waiting?: WaitingInfo;
}

export interface GateResult {
  decision: GateDecision;
  /** Checks this gate run completed, one per head (C-9 resume and sweep can end several). */
  ended: GateEnd[];
  config: GateConfig;
  /** Absent when a resume event matched no waiting PR. */
  pr?: PullSummary;
  /** Whether the gate completed the check itself. */
  checkCompleted: boolean;
  /** Set when the decision is review. */
  waiting?: WaitingInfo;
}

export interface GateOptions {
  now?: () => Date;
}

const checkNameOf = (config: Pick<GateConfig, "name">) => `ai-review/${config.name}`;
const sentence = (s: string) => `${s}.`.replace(/\.\.$/, ".");

/** The newest `ai-review/<name>` run on the SHA. */
async function latestCheck(gh: Github, name: string, sha: string): Promise<CheckRunSummary | undefined> {
  return (await gh.listChecks(sha, name))[0];
}

/**
 * Completes a queued check (C-9) or, when there is none, creates a completed
 * one. A check that is in progress belongs to a running review and is left
 * alone: a new one is created beside it.
 */
async function finishCheck(gh: Github, name: string, sha: string, conclusion: "skipped" | "neutral", output: CheckRunOutput, log: (line: string) => void, queued?: CheckRunSummary) {
  const open = queued ?? (await latestCheck(gh, name, sha));
  if (open !== undefined && open.status === "queued") {
    try {
      await gh.completeCheck(open.id, conclusion, output);
      return;
    } catch (e) {
      log(`could not complete check run ${open.id}: ${e instanceof Error ? e.message : String(e)}; creating a completed one`);
    }
  }
  await gh.createCompletedCheck(name, sha, conclusion, output);
}

/** Configuration for a PR: inputs, then its base SHA's YAML. Cached per base SHA. */
function configLoader(gh: Github, inputs: GateConfig, log: (line: string) => void) {
  const cache = new Map<string, Promise<GateConfig>>();
  return (pr: PullSummary): Promise<GateConfig> => {
    let c = cache.get(pr.baseSha);
    if (c === undefined) {
      c = gh.getFile(".review/review-bot.yaml", pr.baseSha).then((text) => resolveGateConfig(inputs, text, log));
      cache.set(pr.baseSha, c);
    }
    return c;
  };
}

async function authorizationFacts(gh: Github, event: GateEvent, pr: PullSummary, config: GateConfig): Promise<GateFacts> {
  const authorIsMaintainer = await gh.isMaintainer(pr.author.login);
  const facts: GateFacts = { pr, authorIsMaintainer };
  if (needs(event).sender) facts.senderIsMaintainer = await gh.isMaintainer(event.sender);
  if (!authorIsMaintainer && event.action !== "labeled" && pr.labels.includes(config.label)) {
    const applied = (await gh.listLabelEvents(pr.number)).filter((e) => e.event === "labeled" && e.label === config.label);
    const last = applied.at(-1);
    if (last !== undefined) facts.labelApplier = { login: last.actor, isMaintainer: await gh.isMaintainer(last.actor) };
  }
  return facts;
}

/** Reads the required checks; undefined when they cannot be read. */
async function readCi(gh: Github, pr: PullSummary, ci: CiWaitConfig, log: (line: string) => void): Promise<CiState | undefined> {
  try {
    const required = await resolveRequired(gh, ci.require, pr.baseRef);
    return await collectCi(gh, pr.headSha, required, log);
  } catch (e) {
    log(`could not read the required CI checks: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

function waitingOutput(ci: CiState, config: GateConfig, since: string): CheckRunOutput {
  return {
    title: "Waiting for CI",
    summary: [
      `Waiting for CI: ${nameList(ci.pending)}.`,
      `The review starts when the required checks (${nameList(ci.required)}) have passed.`,
      `If one fails, ${config.ci.onFailure === "skip" ? "the review is skipped" : "the review runs anyway and says so"}; if CI has not reported by ${new Date(Date.parse(since) + config.ci.timeoutMs).toISOString()} (${formatDuration(config.ci.timeoutMs)} after ${since}), it is skipped (C-9).`,
    ].join(" "),
  };
}

const CI_FAILED_TITLE = "Skipped: CI failed";
const ciFailedReason = (ci: CiState) => `CI failed: ${nameList(ci.failed)}`;

interface CiOutcome {
  decision: GateDecision;
  waiting?: WaitingInfo;
}

/**
 * The C-9 gate table for an authorized PR. Does not touch the check; the
 * caller does, depending on whether it came from a push or a resume.
 */
function ciOutcome(review: Extract<GateDecision, { kind: "review" }>, config: GateConfig, ci: CiState | undefined, headSeenAt: string): CiOutcome {
  const base = { headSeenAt };
  if (config.ci.require === "off") return { decision: review, waiting: { ...base, ci: "not-required" } };
  if (ci === undefined) {
    return { decision: { ...review, reason: `${review.reason}; the required CI checks could not be read, so the review does not wait for them` }, waiting: { ...base, ci: "unavailable" } };
  }
  if (ci.required.length === 0) return { decision: { ...review, reason: `${review.reason}; no required CI checks` }, waiting: { ...base, ci: "not-required" } };
  const info = (state: "passed" | "failed"): WaitingInfo => ({
    ...base,
    ci: state,
    required: ci.required,
    ...(ci.failed.length > 0 ? { failed: ci.failed } : {}),
    ...(ci.completedAt === undefined ? {} : { ciCompletedAt: ci.completedAt }),
  });
  if (ci.state === "passed") return { decision: { ...review, reason: `${review.reason}; CI passed (${nameList(ci.required)})` }, waiting: info("passed") };
  if (ci.state === "failed") {
    if (config.ci.onFailure === "review") return { decision: { ...review, reason: `${review.reason}; ${ciFailedReason(ci)}, reviewed anyway (ci.onFailure: review)` }, waiting: info("failed") };
    return { decision: { kind: "skip", title: CI_FAILED_TITLE, reason: ciFailedReason(ci), removeLabel: false }, waiting: info("failed") };
  }
  return { decision: { kind: "wait", reason: `waiting for CI: ${nameList(ci.pending)}` } };
}

/** Collects the facts, decides, and writes the check the decision calls for. */
export async function runGate(gh: Github, event: GateEvent, inputs: GateConfig, log: (line: string) => void, o: GateOptions = {}): Promise<GateResult> {
  if (isResumeEvent(event.name)) return runResume(gh, event, inputs, log, o);
  const now = o.now ?? (() => new Date());
  if (event.prNumber === undefined) throw new Error("no pull request number in the event");
  const pr = await gh.getPull(event.prNumber);
  const config = await configLoader(gh, inputs, log)(pr);
  const name = checkNameOf(config);
  const ended: GateEnd[] = [];
  const superseded = await supersede(gh, event, pr, name, log);
  if (superseded !== undefined) ended.push(superseded);
  const decision = decide(event, config, await authorizationFacts(gh, event, pr, config));
  if (decision.kind === "skip") {
    const output = { title: decision.title ?? NOT_AUTHORIZED, summary: sentence(decision.reason) };
    await finishCheck(gh, name, pr.headSha, "skipped", output, log);
    ended.push({ pr, kind: "not-authorized", conclusion: "skipped", output });
    return { decision, ended, config, pr, checkCompleted: true };
  }
  if (decision.kind !== "review") return { decision, ended, config, pr, checkCompleted: false };

  const existing = await latestCheck(gh, name, pr.headSha);
  const queued = existing?.status === "queued" ? existing : undefined;
  const headSeenAt = queued?.startedAt ?? now().toISOString();
  if (event.ignoreCi === true && event.name === "workflow_dispatch") {
    return { decision: { ...decision, reason: `${decision.reason}; CI not waited for (ignore-ci)` }, ended, config, pr, checkCompleted: false, waiting: { headSeenAt, ci: "ignored" } };
  }
  const ci = config.ci.require === "off" ? undefined : await readCi(gh, pr, config.ci, log);
  const out = ciOutcome(decision, config, ci, headSeenAt);
  if (out.decision.kind === "skip") {
    const output = { title: out.decision.title ?? CI_FAILED_TITLE, summary: sentence(out.decision.reason) };
    await finishCheck(gh, name, pr.headSha, "skipped", output, log, queued);
    ended.push({ pr, kind: "ci-failed", conclusion: "skipped", output, ...(out.waiting ? { waiting: out.waiting } : {}) });
    return { decision: out.decision, ended, config, pr, checkCompleted: true };
  }
  if (out.decision.kind === "wait") {
    const output = waitingOutput(ci!, config, headSeenAt);
    if (queued !== undefined) await gh.updateCheck(queued.id, "queued", output);
    else await gh.createQueuedCheck(name, pr.headSha, output, headSeenAt);
    log(`${name} on ${short(pr.headSha)} queued: ${out.decision.reason} (${describeCiConfig(config.ci)})`);
    return { decision: out.decision, ended, config, pr, checkCompleted: false };
  }
  return { decision: out.decision, ended, config, pr, checkCompleted: false, ...(out.waiting ? { waiting: out.waiting } : {}) };
}

/**
 * C-9: a new push while waiting supersedes the old head's queued check. The
 * concurrency group cancels the old gate; this ends the check it left.
 */
async function supersede(gh: Github, event: GateEvent, pr: PullSummary, name: string, log: (line: string) => void): Promise<GateEnd | undefined> {
  const before = event.before;
  if (event.action !== "synchronize" || before === undefined || !/^[0-9a-f]{40}$/.test(before) || before === pr.headSha) return undefined;
  const old = await latestCheck(gh, name, before);
  if (old === undefined || old.status !== "queued") return undefined;
  const output = {
    title: "Superseded by a newer push",
    summary: `New commits were pushed while this commit waited for CI; ${short(pr.headSha)} is reviewed instead (C-9).`,
  };
  await gh.completeCheck(old.id, "skipped", output);
  log(`${name} on ${short(before)} was queued; completed as skipped (superseded by ${short(pr.headSha)})`);
  // The old head's base is not known here; the PR's current base is recorded.
  return { pr: { number: pr.number, headSha: before, baseSha: pr.baseSha }, kind: "superseded", conclusion: "skipped", output };
}

/**
 * An `ai-review/<name>` check left in progress this long belongs to a review
 * job that died without completing it (even the always-run step failed).
 * Well above the reference workflow's prepare and review job limits.
 */
export const STALE_IN_PROGRESS_MS = 4 * 3_600_000;

/**
 * C-9 resume: `workflow_run` and `status` (one SHA) and the scheduled sweep
 * (every open PR). For each PR whose head has a queued `ai-review/<name>`:
 * authorization again, then the required checks. Ready → the first such PR
 * is claimed (its check set in progress, so no other run picks it up) and
 * reviewed by this run; any other ready PR waits for the next event or
 * sweep. Failed, not authorized, or queued longer than `ci.timeout` → the
 * check is completed as skipped. Still pending → left queued.
 *
 * The PR is never taken from the payload: `workflow_run.pull_requests` is
 * empty for forks and nothing else in the payload is trusted beyond the
 * commit SHA, which only selects open PRs whose head it is.
 */
export async function runResume(gh: Github, event: GateEvent, inputs: GateConfig, log: (line: string) => void, o: GateOptions = {}): Promise<GateResult> {
  const now = o.now ?? (() => new Date());
  const sweep = event.name === "schedule";
  const sha = event.headSha;
  if (!sweep && (sha === undefined || !/^[0-9a-f]{40}$/.test(sha))) {
    return { decision: { kind: "ignore", reason: `${event.name} event without a commit SHA` }, ended: [], config: inputs, checkCompleted: false };
  }
  const name = checkNameOf(inputs);
  const open = await gh.listOpenPulls();
  const candidates = sweep ? open : open.filter((p) => p.headSha === sha);
  if (candidates.length === 0) {
    return { decision: { kind: "ignore", reason: sweep ? "no open pull requests" : `no open pull request has head ${short(sha!)}` }, ended: [], config: inputs, checkCompleted: false };
  }
  const loadConfig = configLoader(gh, inputs, log);
  let chosen: GateResult | undefined;
  const ended: GateEnd[] = [];
  let completed = 0;
  let stillWaiting = 0;
  const resumedBy = sweep ? "schedule" : event.name;
  for (const pr of candidates.sort((a, b) => a.number - b.number)) {
    const check = await latestCheck(gh, name, pr.headSha);
    if (check === undefined || check.status === "completed") continue;
    if (check.status !== "queued") {
      // In progress: a review is running. The sweep ends one that died long ago.
      const since = check.startedAt === undefined ? NaN : Date.parse(check.startedAt);
      if (sweep && since + STALE_IN_PROGRESS_MS < now().getTime()) {
        const output = {
          title: "Could not complete",
          summary: `The review of ${short(pr.headSha)} started at ${check.startedAt} and never completed its check. The PR proceeds to human review (S-9).`,
        };
        await gh.completeCheck(check.id, "neutral", output);
        ended.push({ pr, kind: "stale-in-progress", conclusion: "neutral", output });
        log(`#${pr.number}: ${name} in progress since ${check.startedAt}; completed as neutral`);
        completed++;
      }
      continue;
    }
    const config = await loadConfig(pr);
    const seenAt = check.startedAt ?? now().toISOString();
    const auth = decide({ ...event, prNumber: pr.number }, config, await authorizationFacts(gh, { ...event, prNumber: pr.number }, pr, config));
    if (auth.kind !== "review") {
      const reason = auth.reason;
      const output = { title: auth.kind === "skip" ? (auth.title ?? NOT_AUTHORIZED) : NOT_AUTHORIZED, summary: sentence(reason) };
      await finishCheck(gh, name, pr.headSha, "skipped", output, log, check);
      ended.push({ pr, kind: "not-authorized", conclusion: "skipped", output });
      log(`#${pr.number}: not authorized any more; completed as skipped`);
      completed++;
      continue;
    }
    const ci = config.ci.require === "off" ? undefined : await readCi(gh, pr, config.ci, log);
    const out = ciOutcome(auth, config, ci, seenAt);
    if (out.decision.kind === "skip") {
      const output = { title: out.decision.title ?? CI_FAILED_TITLE, summary: sentence(out.decision.reason) };
      await finishCheck(gh, name, pr.headSha, "skipped", output, log, check);
      ended.push({ pr, kind: "ci-failed", conclusion: "skipped", output, ...(out.waiting ? { waiting: { ...out.waiting, resumedBy } } : {}) });
      log(`#${pr.number}: ${out.decision.reason}; completed as skipped`);
      completed++;
      continue;
    }
    if (out.decision.kind === "wait") {
      const waited = now().getTime() - Date.parse(seenAt);
      if (!(waited < config.ci.timeoutMs)) {
        const output = {
          title: "Skipped: CI did not report",
          summary: `CI did not report within ${formatDuration(config.ci.timeoutMs)}: ${nameList(ci!.pending)} (waiting since ${seenAt}). Push again or dispatch the review to retry (C-9).`,
        };
        await gh.completeCheck(check.id, "skipped", output);
        ended.push({ pr, kind: "ci-timeout", conclusion: "skipped", output, waiting: { headSeenAt: seenAt, ci: "timed-out", required: ci!.required, resumedBy } });
        log(`#${pr.number}: CI did not report within ${formatDuration(config.ci.timeoutMs)}; completed as skipped`);
        completed++;
      } else {
        stillWaiting++;
      }
      continue;
    }
    if (out.decision.kind !== "review") continue;
    if (chosen !== undefined) {
      log(`#${pr.number} is ready as well; it is resumed by the next event or sweep`);
      continue;
    }
    // Claim it: from here on, other runs see it in progress and leave it alone.
    await gh.updateCheck(check.id, "in_progress", { title: "Review starting", summary: sentence(out.decision.reason) });
    chosen = { decision: out.decision, ended, config, pr, checkCompleted: false, waiting: { ...out.waiting!, resumedBy } };
  }
  log(`${resumedBy}: ${candidates.length} candidate PR(s); ${completed} check(s) completed, ${stillWaiting} still waiting${chosen?.pr ? `, #${chosen.pr.number} resumed` : ""}`);
  if (chosen !== undefined) return chosen;
  return {
    decision: { kind: "ignore", reason: completed > 0 ? `${completed} waiting check(s) completed; nothing to review` : stillWaiting > 0 ? `${stillWaiting} PR(s) still waiting for CI` : "no PR is waiting for CI" },
    ended,
    config: inputs,
    checkCompleted: completed > 0,
  };
}

/**
 * Parses the Actions event payload into a `GateEvent`. `prOverride` is the
 * dispatch input. For `workflow_run` and `status` only the commit SHA is
 * taken (`workflow_run.head_sha`, `status.sha`); branch names, titles and
 * PR lists in those payloads are not used.
 */
export function gateEventFrom(eventName: string, payload: unknown, prOverride?: number): GateEvent {
  const p = (payload ?? {}) as {
    action?: string;
    label?: { name?: string };
    sender?: { login?: string };
    pull_request?: { number?: number; head?: { sha?: string } };
    inputs?: Record<string, unknown>;
    before?: string;
    sha?: string;
    workflow_run?: { head_sha?: string };
  };
  if (isResumeEvent(eventName)) {
    const event: GateEvent = { name: eventName, sender: p.sender?.login ?? "" };
    const sha = eventName === "workflow_run" ? p.workflow_run?.head_sha : eventName === "status" ? p.sha : undefined;
    if (sha !== undefined) event.headSha = sha;
    return event;
  }
  const fromInputs = p.inputs?.pr ?? p.inputs?.["pr-number"];
  const number = prOverride ?? p.pull_request?.number ?? (fromInputs === undefined ? undefined : Number(fromInputs));
  if (number === undefined || !Number.isSafeInteger(number) || number < 1) throw new Error("no pull request number in the event; give --pr");
  const event: GateEvent = { name: eventName, sender: p.sender?.login ?? "", prNumber: number };
  if (p.action !== undefined) event.action = p.action;
  if (p.label?.name !== undefined) event.label = p.label.name;
  if (p.pull_request?.head?.sha !== undefined) event.headSha = p.pull_request.head.sha;
  if (eventName === "pull_request_target" && p.action === "synchronize" && typeof p.before === "string") event.before = p.before;
  const ignore = p.inputs?.["ignore-ci"];
  if (eventName === "workflow_dispatch" && (ignore === true || ignore === "true")) event.ignoreCi = true;
  return event;
}

export { DEFAULT_CI_WAIT };
