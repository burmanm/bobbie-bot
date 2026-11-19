/**
 * Per-area `REVIEW.md` (A-5): a `REVIEW.md` in a subdirectory applies to
 * changes under that directory, in addition to the root one. This module
 * says which files apply to a path and how their mechanically parsed
 * sections combine. Pure.
 *
 * How they combine:
 * - **Skip these paths** — every applicable file's entries apply (union).
 *   An area file's globs are relative to its own directory, the way a
 *   `.gitignore` in a subdirectory works: `*.pb.go` matches at any depth
 *   below it, `/gen/` and `gen/x.go` are anchored at it. An area cannot
 *   un-skip what the root skips.
 * - **Limits (nit cap)** — the root cap counts every nit in the review; an
 *   area cap counts the nits anchored under that area. A nit is posted only
 *   if every cap that applies to it still has room, so the strictest wins
 *   and an area cannot raise the root's cap. Important findings are never
 *   capped.
 * - Everything else is given to the reviewer verbatim, each file labelled
 *   with the paths it applies to; a file nearer the code is more specific.
 */
import { isLive } from "./grounding.ts";
import type { FilePatch } from "./diff.ts";
import type { ReviewMd, SkipEntry } from "./review-md.ts";
import type { Finding } from "./schemas.ts";
import { globToRegExp, type SkipResult } from "./skip.ts";

export interface ReviewArea {
  /** Directory the file sits in, repository-relative, no trailing slash; "" for the root. */
  dir: string;
  /** The file's repository path, e.g. "REVIEW.md" or "pkg/api/REVIEW.md". */
  path: string;
  parsed: ReviewMd;
}

/** Whether `path` is under `dir` ("" contains everything). */
export function inArea(dir: string, path: string): boolean {
  return dir === "" || path.startsWith(`${dir}/`);
}

/** The areas that apply to `path`, root first, then nearer and nearer. */
export function areasFor(areas: readonly ReviewArea[], path: string): ReviewArea[] {
  return areas.filter((a) => inArea(a.dir, path)).sort((a, b) => depth(a.dir) - depth(b.dir));
}

function depth(dir: string): number {
  return dir === "" ? 0 : dir.split("/").length;
}

/** Directories that could hold an area file for these paths: every proper ancestor except the root. */
export function candidateAreaDirs(paths: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const p of paths) {
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join("/"));
  }
  return [...dirs].sort();
}

/**
 * Skip paths with area files (S-2): binary files always; a file is skipped
 * when an entry of any file that applies to it matches, the glob taken
 * relative to that file's directory. Entries with a prose qualifier are
 * not hard-filtered, as with the root file.
 */
export function applyAreaSkips(files: readonly FilePatch[], areas: readonly ReviewArea[]): SkipResult {
  const compiled = areas.map((a) => ({
    a,
    entries: a.parsed.skipEntries.map((e: SkipEntry) => ({ e, re: globToRegExp(e.glob) })),
  }));
  const result: SkipResult = { included: [], excluded: [], softSkips: [] };
  for (const f of files) {
    if (f.binary) {
      result.excluded.push({ path: f.path, reason: "binary file" });
      continue;
    }
    const paths = [f.newPath, f.oldPath].filter((p): p is string => p !== undefined);
    const matches = (dir: string, re: RegExp) => paths.some((p) => inArea(dir, p) && re.test(dir === "" ? p : p.slice(dir.length + 1)));
    let hard: { a: ReviewArea; glob: string } | undefined;
    for (const { a, entries } of compiled) {
      const hit = entries.find(({ e, re }) => e.qualifier === undefined && matches(a.dir, re));
      if (hit) {
        hard = { a, glob: hit.e.glob };
        break;
      }
    }
    if (hard) {
      result.excluded.push({ path: f.path, reason: `${hard.a.path} "Skip these paths": ${hard.glob}` });
      continue;
    }
    for (const { a, entries } of compiled) {
      for (const { e, re } of entries) {
        if (e.qualifier !== undefined && matches(a.dir, re)) {
          result.softSkips.push({ path: f.path, glob: e.glob, qualifier: e.qualifier, ...(a.dir === "" ? {} : { source: a.path }) });
        }
      }
    }
    result.included.push(f);
  }
  return result;
}

export interface AreaNitCap {
  dir: string;
  path: string;
  cap: number;
}

export function areaNitCaps(areas: readonly ReviewArea[]): AreaNitCap[] {
  return areas.filter((a) => a.parsed.nitCap !== undefined).map((a) => ({ dir: a.dir, path: a.path, cap: a.parsed.nitCap! }));
}

/**
 * Nit caps from the root and area files (S-6). Live Nits are taken in input
 * order; a Nit is `over-limit` when any cap that applies to its anchor is
 * already full, and only a posted Nit counts against the caps.
 */
export function applyAreaNitCaps(findings: readonly Finding[], caps: readonly AreaNitCap[]): Finding[] {
  if (caps.length === 0) return [...findings];
  const used = new Map<AreaNitCap, number>();
  return findings.map((f) => {
    if (f.tag !== "nit" || !isLive(f)) return f;
    const anchor = f.locations[0]?.path ?? "";
    const applicable = caps.filter((c) => inArea(c.dir, anchor));
    const full = applicable.find((c) => (used.get(c) ?? 0) >= c.cap);
    if (full !== undefined) {
      const where = full.dir === "" ? "" : ` for ${full.dir}/`;
      return { ...f, status: "over-limit", statusReason: `over the nit cap of ${full.cap}${where} from ${full.path} Limits` };
    }
    for (const c of applicable) used.set(c, (used.get(c) ?? 0) + 1);
    return f;
  });
}
