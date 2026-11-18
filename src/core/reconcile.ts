/**
 * Reconcile (S-6): deduplicate within the run and against fingerprints
 * already posted on the PR, then apply the nit cap from `REVIEW.md` Limits.
 * Important findings are never capped; Pre-existing ones don't count (I-2,
 * cass-operator REVIEW.md Limits).
 *
 * Findings are never mutated; new objects are returned in the input order.
 */
import { isLive } from "./grounding.ts";
import type { Finding, Location, Tag } from "./schemas.ts";

const TAG_RANK: Record<Tag, number> = { important: 0, nit: 1, "pre-existing": 2 };
const STATUS_RANK: Record<string, number> = { verified: 0, proposed: 1, unverified: 2 };

function overlaps(a: Location, b: Location): boolean {
  return a.path === b.path && a.startLine <= b.endLine && b.startLine <= a.endLine;
}

/**
 * Mark duplicates. A finding is a duplicate when its fingerprint was already
 * posted on this PR, when an earlier-kept finding in this run has the same
 * fingerprint, or when an earlier-kept finding has the same category and an
 * overlapping location. "Earlier-kept" follows priority, not input order:
 * Important before Nit before Pre-existing, verified before unverified, then
 * input order — so a duplicate never displaces a stronger finding.
 */
export function dedupe(findings: readonly Finding[], priorFingerprints: ReadonlySet<string> = new Set()): Finding[] {
  const out = [...findings];
  const order = out
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => isLive(f))
    .sort(
      (a, b) =>
        TAG_RANK[a.f.tag] - TAG_RANK[b.f.tag] ||
        (STATUS_RANK[a.f.status] ?? 9) - (STATUS_RANK[b.f.status] ?? 9) ||
        a.i - b.i,
    );
  const kept: Finding[] = [];
  for (const { f, i } of order) {
    if (priorFingerprints.has(f.fingerprint)) {
      out[i] = { ...f, status: "duplicate", statusReason: "already raised on this PR (same fingerprint)" };
      continue;
    }
    const same = kept.find((k) => k.fingerprint === f.fingerprint);
    if (same) {
      out[i] = { ...f, status: "duplicate", statusReason: `duplicate of ${same.id} (same fingerprint)` };
      continue;
    }
    const near = kept.find((k) => k.category === f.category && k.locations.some((a) => f.locations.some((b) => overlaps(a, b))));
    if (near) {
      out[i] = { ...f, status: "duplicate", statusReason: `duplicate of ${near.id} (overlapping location, same category)` };
      continue;
    }
    kept.push(f);
  }
  return out;
}

/**
 * Keep at most `cap` live Nits, in input order; the rest become
 * `over-limit` (recorded, not posted). No cap when `cap` is undefined.
 */
export function applyNitCap(findings: readonly Finding[], cap: number | undefined): Finding[] {
  if (cap === undefined) return [...findings];
  let n = 0;
  return findings.map((f) => {
    if (f.tag !== "nit" || !isLive(f)) return f;
    n++;
    if (n <= cap) return f;
    return { ...f, status: "over-limit", statusReason: `over the nit cap of ${cap} from REVIEW.md Limits` };
  });
}

/** S-6 in one call: dedupe, then the nit cap. */
export function reconcile(findings: readonly Finding[], opts: { priorFingerprints?: ReadonlySet<string>; nitCap?: number | undefined }): Finding[] {
  return applyNitCap(dedupe(findings, opts.priorFingerprints), opts.nitCap);
}

/** Ids of findings that are not published and have no statusReason (A-3 invariant). */
export function missingStatusReasons(findings: readonly Finding[]): string[] {
  return findings.filter((f) => f.status !== "published" && !f.statusReason).map((f) => f.id);
}
