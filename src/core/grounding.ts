/**
 * Mechanical grounding (S-5, P-1): checks code can make without a model.
 *
 * - Re-validate schema and cross-field rules (defence in depth).
 * - Every evidence quote must appear at its cited root, path and lines;
 *   otherwise the finding is refuted ("evidence not found").
 * - An Important or Nit finding anchored outside the diff is re-tagged
 *   Pre-existing (it then goes to the summary, not inline). One anchored
 *   partly inside has its anchor cut to the hunk it overlaps, so GitHub
 *   accepts it as an inline comment (the fingerprint was taken before).
 *
 * Also applies the verifier's verdict (S-5, adversarial step).
 *
 * Findings are never mutated; new objects are returned in the same order.
 */
import { clampToDiff, type DiffIndex } from "./diff.ts";
import { normalizeAnchor, sliceLines, type FileLookup } from "./fingerprint.ts";
import { ReportFindingParams, validateOutput, type Evidence, type Finding, type ProducerFinding, type Verdict } from "./schemas.ts";

/** Statuses still in play (not dropped). */
export const LIVE_STATUSES: ReadonlySet<Finding["status"]> = new Set(["proposed", "verified", "unverified"]);
export const isLive = (f: Finding): boolean => LIVE_STATUSES.has(f.status);

const PRODUCER_KEYS = Object.keys(ReportFindingParams.properties) as Array<keyof ProducerFinding>;

/** The producer-set part of a finding (A-3), for re-validation. */
export function producerPart(f: Finding): ProducerFinding {
  const out: Record<string, unknown> = {};
  for (const k of PRODUCER_KEYS) if (f[k] !== undefined) out[k] = f[k];
  return out as ProducerFinding;
}

function cite(e: Pick<Evidence, "root" | "path" | "startLine" | "endLine">): string {
  return `${e.root}:${e.path}:${e.startLine}-${e.endLine}`;
}

/**
 * Does the quote appear in the cited lines? Whitespace runs are collapsed on
 * both sides (models re-indent), otherwise the match is exact. An empty quote
 * never matches.
 */
export function quoteFound(e: Evidence, lookup: FileLookup): boolean {
  const quote = normalizeAnchor(e.quote.replace(/\r\n?/g, "\n"));
  if (quote === "") return false;
  const text = lookup(e.root, e.path);
  if (text === undefined) return false;
  const lines = sliceLines(text, e.startLine, e.endLine);
  if (lines === undefined) return false;
  return normalizeAnchor(lines.join("\n")).includes(quote);
}

export interface GroundingContext {
  /** Diff of the files under review (after skips). */
  diff: DiffIndex;
  lookup: FileLookup;
}

function refute(f: Finding, reason: string): Finding {
  return { ...f, status: "refuted", statusReason: reason };
}

/** Ground one finding. Only `proposed` findings are checked; others pass through unchanged. */
export function groundFinding(f: Finding, ctx: GroundingContext): Finding {
  if (f.status !== "proposed") return f;

  const errors = validateOutput("report_finding", producerPart(f));
  if (errors.length > 0) return refute(f, `invalid finding: ${errors.join("; ")}`);

  const missing = f.evidence.filter((e) => !quoteFound(e, ctx.lookup));
  if (missing.length > 0) return refute(f, `evidence not found: ${missing.map(cite).join(", ")}`);

  const anchor = f.locations[0]!;
  if (f.tag === "pre-existing") return f;
  const inDiff = clampToDiff(ctx.diff, anchor.path, anchor.startLine, anchor.endLine);
  if (!inDiff) {
    return {
      ...f,
      tag: "pre-existing",
      retaggedFrom: f.tag,
      statusReason: `anchor ${anchor.path}:${anchor.startLine} is outside the diff; re-tagged pre-existing from ${f.tag}`,
    };
  }
  if (inDiff.start === anchor.startLine && inDiff.end === anchor.endLine) return f;
  return { ...f, locations: [{ ...anchor, startLine: inDiff.start, endLine: inDiff.end }, ...f.locations.slice(1)] };
}

export function groundFindings(findings: readonly Finding[], ctx: GroundingContext): Finding[] {
  return findings.map((f) => groundFinding(f, ctx));
}

/**
 * Apply a verifier verdict (S-5): refuted → dropped, confirmed → verified,
 * inconclusive → unverified (published with that label). Only live findings
 * change; an invalid verdict leaves the finding unverified.
 */
export function applyVerdict(f: Finding, verdict: Verdict): Finding {
  if (!isLive(f)) return f;
  const errors = validateOutput("submit_verdict", verdict);
  if (errors.length > 0) {
    return { ...f, status: "unverified", statusReason: `verifier returned an invalid verdict: ${errors.join("; ")}` };
  }
  switch (verdict.verdict) {
    case "refuted":
      return { ...f, status: "refuted", statusReason: `refuted by verifier: ${verdict.reasoning}`, verdict };
    case "confirmed":
      return { ...f, status: "verified", statusReason: "confirmed by verifier", verdict };
    case "inconclusive":
      return { ...f, status: "unverified", statusReason: `verifier inconclusive: ${verdict.reasoning}`, verdict };
  }
}
