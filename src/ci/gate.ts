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
 */
import { parseBotConfigYaml } from "../pipeline/index.ts";
import type { Github, PullSummary } from "./github.ts";

export const DEFAULT_AUTH_LABEL = "ai-review/approved";
export const LIFETIMES = ["per-push", "per-pr"] as const;
export type LabelLifetime = (typeof LIFETIMES)[number];

/** `pull_request_target` actions the reference workflow subscribes to (C-2). */
export const REVIEW_ACTIONS = ["opened", "reopened", "ready_for_review", "synchronize", "labeled"] as const;

export interface GateConfig {
  /** Reviewer name; the check run is `ai-review/<name>`. */
  name: string;
  label: string;
  lifetime: LabelLifetime;
}

export interface GateEvent {
  /** `pull_request_target` or `workflow_dispatch`; anything else is ignored. */
  name: string;
  /** The `pull_request_target` action. */
  action?: string;
  /** `labeled`: the label that was applied. */
  label?: string;
  /** Who triggered the event: labeler, pusher, dispatcher. */
  sender: string;
  prNumber: number;
  /** The PR head SHA in the event payload (what the labeler saw). */
  headSha?: string;
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
  | { kind: "skip"; reason: string; removeLabel: boolean }
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

function short(sha: string): string {
  return sha.slice(0, 7);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Inputs first, then `authorization` from `.review/review-bot.yaml` on the
 * base SHA (A-5, C-2). The check name is never taken from the YAML: the
 * pipeline does not either (the check opens before the YAML is read).
 * An invalid YAML file keeps the input label but forces `per-push`, the
 * stricter lifetime; the review itself then reports the configuration error.
 */
export function resolveGateConfig(inputs: GateConfig, yamlText: string | undefined, warn: (line: string) => void): GateConfig {
  if (yamlText === undefined) return inputs;
  try {
    const y = parseBotConfigYaml(yamlText);
    const a = y.authorization;
    const label = a?.label !== undefined && a.label.trim() !== "" ? a.label.trim() : inputs.label;
    return { name: inputs.name, label, lifetime: a?.lifetime ?? inputs.lifetime };
  } catch (e) {
    warn(`${e instanceof Error ? e.message : String(e)}; using label "${inputs.label}" with lifetime per-push`);
    return { ...inputs, lifetime: "per-push" };
  }
}

export interface GateResult {
  decision: GateDecision;
  config: GateConfig;
  pr: PullSummary;
  /** Whether the gate completed the check itself. */
  checkCompleted: boolean;
}

/** Collects the facts, decides, and completes the check as skipped when not authorized. */
export async function runGate(gh: Github, event: GateEvent, inputs: GateConfig, log: (line: string) => void): Promise<GateResult> {
  const pr = await gh.getPull(event.prNumber);
  const config = resolveGateConfig(inputs, await gh.getFile(".review/review-bot.yaml", pr.baseSha), log);
  const authorIsMaintainer = await gh.isMaintainer(pr.author.login);
  const facts: GateFacts = { pr, authorIsMaintainer };
  if (needs(event).sender) facts.senderIsMaintainer = await gh.isMaintainer(event.sender);
  if (!authorIsMaintainer && event.action !== "labeled" && pr.labels.includes(config.label)) {
    const applied = (await gh.listLabelEvents(pr.number)).filter((e) => e.event === "labeled" && e.label === config.label);
    const last = applied.at(-1);
    if (last !== undefined) facts.labelApplier = { login: last.actor, isMaintainer: await gh.isMaintainer(last.actor) };
  }
  const decision = decide(event, config, facts);
  let checkCompleted = false;
  if (decision.kind === "skip") {
    await gh.createCompletedCheck(`ai-review/${config.name}`, pr.headSha, "skipped", {
      title: "Skipped: not authorized for automatic review",
      summary: `${decision.reason}.`.replace(/\.\.$/, "."),
    });
    checkCompleted = true;
  }
  return { decision, config, pr, checkCompleted };
}

/** Parses the Actions event payload into a `GateEvent`. `prOverride` is the dispatch input. */
export function gateEventFrom(eventName: string, payload: unknown, prOverride?: number): GateEvent {
  const p = (payload ?? {}) as {
    action?: string;
    label?: { name?: string };
    sender?: { login?: string };
    pull_request?: { number?: number; head?: { sha?: string } };
    inputs?: Record<string, unknown>;
  };
  const fromInputs = p.inputs?.pr ?? p.inputs?.["pr-number"];
  const number = prOverride ?? p.pull_request?.number ?? (fromInputs === undefined ? undefined : Number(fromInputs));
  if (number === undefined || !Number.isSafeInteger(number) || number < 1) throw new Error("no pull request number in the event; give --pr");
  const event: GateEvent = { name: eventName, sender: p.sender?.login ?? "", prNumber: number };
  if (p.action !== undefined) event.action = p.action;
  if (p.label?.name !== undefined) event.label = p.label.name;
  if (p.pull_request?.head?.sha !== undefined) event.headSha = p.pull_request.head.sha;
  return event;
}
