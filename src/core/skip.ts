/**
 * Skip paths (S-2): binary files are always skipped; everything else comes
 * from the `REVIEW.md` "Skip these paths" entries. Entries with a prose
 * qualifier are not hard-filtered: the reviewer reads `REVIEW.md` and
 * decides. Every exclusion is recorded with its reason.
 *
 * Glob dialect (gitignore-like, the simplest reading that matches how the
 * template's entries are written):
 * - `*` matches within one path segment, `?` one character, `[...]` a class;
 * - `**` as a whole segment matches zero or more segments;
 * - `{a,b}` alternatives;
 * - a leading `/` anchors at the root; a pattern with no `/` at all matches
 *   the file name at any depth (`go.sum`, `*.pb.go`);
 * - a trailing `/` matches everything below that directory.
 */
import type { FilePatch } from "./diff.ts";
import type { SkipEntry } from "./review-md.ts";

function escapeRe(c: string): string {
  return /[\\^$.|+(){}[\]*?]/.test(c) ? "\\" + c : c;
}

function segmentToRe(seg: string): string {
  let re = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const close = seg.indexOf("]", i + 2);
      if (close < 0) {
        re += "\\[";
        continue;
      }
      let cls = seg.slice(i + 1, close);
      const neg = cls.startsWith("!") || cls.startsWith("^");
      if (neg) cls = cls.slice(1);
      re += "[" + (neg ? "^" : "") + cls.replace(/[\\\]^]/g, "\\$&") + "]";
      i = close;
    } else if (c === "{") {
      const close = seg.indexOf("}", i);
      if (close < 0) {
        re += "\\{";
        continue;
      }
      const alts = seg.slice(i + 1, close).split(",").map(segmentToRe);
      re += "(?:" + alts.join("|") + ")";
      i = close;
    } else {
      re += escapeRe(c);
    }
  }
  return re;
}

/** Compile a skip glob to an anchored RegExp over repository-relative paths. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/^\.\//, "");
  const rooted = g.startsWith("/");
  if (rooted) g = g.slice(1);
  if (g.endsWith("/")) g += "**";
  if (!rooted && !g.includes("/")) {
    // No slash: match the name at any depth.
    return new RegExp("^(?:.*/)?" + segmentToRe(g) + "$");
  }
  const segs = g.split("/");
  let re = "^";
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const last = i === segs.length - 1;
    if (s === "**") {
      re += last ? ".*" : "(?:[^/]+/)*";
    } else {
      re += segmentToRe(s) + (last ? "" : "/");
    }
  }
  return new RegExp(re + "$");
}

export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path);
}

export interface Exclusion {
  path: string;
  reason: string;
}

export interface SoftSkip {
  path: string;
  glob: string;
  qualifier: string;
  /** The area REVIEW.md the entry comes from; absent for the root file (A-5). */
  source?: string;
}

export interface SkipResult {
  included: FilePatch[];
  excluded: Exclusion[];
  /** Files matched only by qualified entries: reviewed, and the reviewer applies the qualifier. */
  softSkips: SoftSkip[];
}

/**
 * Apply skip rules. A file is matched by its head path, or by its base path
 * when deleted; a rename is skipped when either path matches.
 */
export function applySkips(files: readonly FilePatch[], entries: readonly SkipEntry[]): SkipResult {
  const compiled = entries.map((e) => ({ e, re: globToRegExp(e.glob) }));
  const result: SkipResult = { included: [], excluded: [], softSkips: [] };
  for (const f of files) {
    if (f.binary) {
      result.excluded.push({ path: f.path, reason: "binary file" });
      continue;
    }
    const paths = [f.newPath, f.oldPath].filter((p): p is string => p !== undefined);
    const hard = compiled.find(({ e, re }) => e.qualifier === undefined && paths.some((p) => re.test(p)));
    if (hard) {
      result.excluded.push({ path: f.path, reason: `REVIEW.md "Skip these paths": ${hard.e.glob}` });
      continue;
    }
    for (const { e, re } of compiled) {
      if (e.qualifier !== undefined && paths.some((p) => re.test(p))) {
        result.softSkips.push({ path: f.path, glob: e.glob, qualifier: e.qualifier });
      }
    }
    result.included.push(f);
  }
  return result;
}
