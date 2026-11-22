/**
 * Prior state (S-1, D-5): what earlier runs of this bot left on the PR,
 * recovered from hidden markers. A marker counts only on a comment the
 * platform found recorded for this bot (`recordedBy`; H-50, S-7, C-5): core
 * decoding proves the text well formed, and neither the login nor the
 * author type proves who wrote it. Everything else is someone else's comment.
 */
import { decodeMarker, decodeOwnMarker } from "../core/index.ts";
import type { PrComment } from "../platform/index.ts";

export const OUTCOME_PREFIXES = ["wrong", "intentional", "not-worth-it"] as const;
export type OutcomePrefix = (typeof OUTCOME_PREFIXES)[number];

export interface PriorFinding {
  commentId: string;
  fingerprint: string;
  path?: string;
  line?: number;
  startLine?: number;
  body: string;
  /** First line of the comment, without the tag. */
  title: string;
  tag?: "important" | "nit";
  threadResolved?: boolean;
  /** The first `[wrong]` / `[intentional]` / `[not-worth-it]` reply in the thread (L-2). */
  outcomeReply?: OutcomePrefix;
}

export interface PriorState {
  /** Head SHA of the latest summary marker. */
  lastReviewedSha?: string;
  /** Number of earlier runs that posted a summary. */
  rounds: number;
  findings: PriorFinding[];
  fingerprints: Set<string>;
  /** Thread-root inline comments by anyone else (humans, other bots), for S-6 dedupe. */
  othersInline: PrComment[];
}

const isBot = (c: PrComment) => c.author.type === "Bot";

/** "**Important.** Title text" → { tag, title } */
export function parseCommentHead(body: string): { tag?: "important" | "nit"; title: string } {
  const first = (body.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").replace(/\*\*/g, "").trim();
  const m = /^(important|nit)\b\s*[.:]?\s*(.*)$/i.exec(first);
  if (!m) return { title: first };
  return { tag: m[1]!.toLowerCase() as "important" | "nit", title: m[2]!.trim() };
}

function outcomeOf(body: string): OutcomePrefix | undefined {
  const m = /^\s*\[(wrong|intentional|not-worth-it)\]/i.exec(body);
  return m ? (m[1]!.toLowerCase() as OutcomePrefix) : undefined;
}

export function derivePriorState(comments: readonly PrComment[], botId: string): PriorState {
  const state: PriorState = { rounds: 0, findings: [], fingerprints: new Set(), othersInline: [] };
  const summaries: Array<{ sha: string; run: string; at: string; index: number }> = [];
  const ownIds = new Set<string>();

  comments.forEach((c, index) => {
    if (c.kind === "review" || c.kind === "issue-comment") {
      const m = c.recordedBy === botId ? decodeOwnMarker(c.body, "summary", botId) : undefined;
      if (m) summaries.push({ sha: m.sha, run: m.run, at: c.createdAt ?? "", index });
      return;
    }
    if (c.inReplyTo !== undefined) return;
    const m = c.recordedBy === botId ? decodeOwnMarker(c.body, "finding", botId) : undefined;
    if (!m) {
      state.othersInline.push(c);
      return;
    }
    ownIds.add(c.id);
    const head = parseCommentHead(c.body);
    const f: PriorFinding = { commentId: c.id, fingerprint: m.fingerprint, body: c.body, title: head.title };
    if (head.tag !== undefined) f.tag = head.tag;
    if (c.path !== undefined) f.path = c.path;
    if (c.line !== undefined) f.line = c.line;
    if (c.startLine !== undefined) f.startLine = c.startLine;
    if (c.threadResolved !== undefined) f.threadResolved = c.threadResolved;
    state.findings.push(f);
    state.fingerprints.add(m.fingerprint);
  });

  // Outcome replies by anyone other than this bot, in comment order.
  for (const c of comments) {
    if (c.kind !== "review-comment" || c.inReplyTo === undefined || !ownIds.has(c.inReplyTo)) continue;
    if (isBot(c) && decodeMarker(c.body, "finding", botId)) continue;
    const outcome = outcomeOf(c.body);
    const f = state.findings.find((x) => x.commentId === c.inReplyTo);
    if (f && outcome && f.outcomeReply === undefined) f.outcomeReply = outcome;
  }

  // Latest summary: by timestamp when present, else by comment order.
  summaries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.index - b.index));
  state.rounds = new Set(summaries.map((s) => s.run)).size;
  const last = summaries[summaries.length - 1];
  if (last) state.lastReviewedSha = last.sha;
  return state;
}

/** Earlier findings to re-check: open threads with no outcome reply (S-6). */
export function openPriorFindings(state: PriorState): PriorFinding[] {
  return state.findings.filter((f) => f.threadResolved !== true && f.outcomeReply === undefined);
}
