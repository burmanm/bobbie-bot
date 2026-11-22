/**
 * S-7 payloads, assembled by code from typed parts: inline comments for live
 * Important and Nit findings (tag first, I-2 #3), thread replies, and the
 * one COMMENT review (I-2 #8). All text from the model or the PR passes
 * through core's markdown.ts, so it cannot forge the bot's state (D-5) or
 * become live Markdown (C-3, H-51).
 */
import { codeSpan, encodeMarker, type Finding, formatLocation, isLive, safeLine, safeSuggestion, safeText } from "../core/index.ts";
import type { ReviewCommentPayload, ReviewPayload } from "../platform/index.ts";

const TAG_WORD = { important: "Important", nit: "Nit", "pre-existing": "Pre-existing" } as const;

/** Body of one inline comment. The tag is the first word (I-2 #3); the marker is the last line. */
export function findingCommentBody(f: Finding, bot: string, runId: string): string {
  const parts: string[] = [];
  const title = safeLine(f.title.trim().replace(/\.$/, ""));
  parts.push(`**${TAG_WORD[f.tag]}.** ${title}.`);
  if (f.status === "unverified") {
    parts.push(`_Unverified: an independent check could neither confirm nor refute this${f.verdict ? "" : " (no verdict)"}._`);
  }
  parts.push(safeText(f.body));
  if (f.locations.length > 1) {
    parts.push(`**Also at:** ${f.locations.slice(1).map((l) => codeSpan(formatLocation(l))).join(", ")}`);
  }
  const traced = f.traced.map(safeLine).filter((t) => t !== "");
  const assumed = f.assumed.map(safeLine).filter((t) => t !== "");
  if (traced.length > 0) parts.push(`**Traced:** ${traced.join("; ")}`);
  if (assumed.length > 0) parts.push(`**Assumed:** ${assumed.join("; ")}`);
  if (f.suggestion !== undefined && f.suggestion.trim() !== "") {
    parts.push(safeSuggestion(f.suggestion));
  }
  parts.push(encodeMarker({ kind: "finding", bot, run: runId, fingerprint: f.fingerprint, fingerprintVersion: f.fingerprintVersion }));
  return parts.join("\n\n") + "\n";
}

/** Inline comment for a live Important or Nit finding (Pre-existing goes to the summary only, I-2 #4). */
export function inlineComment(f: Finding, bot: string, runId: string): ReviewCommentPayload {
  const anchor = f.locations[0]!;
  const c: ReviewCommentPayload = { path: anchor.path, line: anchor.endLine, side: "RIGHT", body: findingCommentBody(f, bot, runId) };
  if (anchor.endLine > anchor.startLine) {
    c.start_line = anchor.startLine;
    c.start_side = "RIGHT";
  }
  return c;
}

export function inlineFindings(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => isLive(f) && (f.tag === "important" || f.tag === "nit"));
}

export function buildReview(headSha: string, summary: string, findings: readonly Finding[], bot: string, runId: string): ReviewPayload {
  return {
    commit_id: headSha,
    event: "COMMENT",
    body: summary,
    comments: inlineFindings(findings).map((f) => inlineComment(f, bot, runId)),
  };
}

export function recheckReplyBody(status: "fixed" | "still-open", headSha: string, detail: string): string {
  const head = status === "fixed" ? `**Verified fixed at \`${headSha.slice(0, 7)}\`.**` : `**Still open at \`${headSha.slice(0, 7)}\`.**`;
  return `${head} ${safeText(detail, { inline: true })}\n`;
}

export function failureCommentBody(headSha: string, reason: string): string {
  return `Automated review could not complete for \`${headSha.slice(0, 7) || "unknown"}\`: ${safeLine(reason.trim().slice(0, 300))}. The pull request proceeds to human review.\n`;
}
