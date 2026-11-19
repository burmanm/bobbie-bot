/**
 * S-2 deterministic pass: parse the diff, apply skip paths (binary always;
 * the rest from base `REVIEW.md`), write one patch file per reviewed file,
 * and chunk large PRs by directory (S-4 Phase 1). No checks are run here.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyAreaSkips, type Exclusion, type FilePatch, parseDiff, type ReviewArea, type SoftSkip } from "../core/index.ts";

export interface PatchFile {
  path: string;
  oldPath?: string;
  status: FilePatch["status"];
  added: number;
  removed: number;
  /** Lines in the patch text. */
  lines: number;
  /** Relative to the inputs root, e.g. "patches/0003-pkg_a.go.patch". */
  patchPath: string;
}

export interface DeterministicResult {
  /** Every file in the reviewed diff. */
  all: FilePatch[];
  included: FilePatch[];
  excluded: Exclusion[];
  softSkips: SoftSkip[];
  patches: PatchFile[];
}

function count(f: FilePatch, side: "added" | "removed"): number {
  return f.hunks.reduce((n, h) => n + h[side].reduce((m, r) => m + r.end - r.start + 1, 0), 0);
}

/**
 * Patch file name: a sequence number plus a flattened, filtered copy of the
 * path. Diff paths are PR-controlled, so they never become directories.
 */
export function patchFileName(index: number, path: string): string {
  const flat = path.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_").slice(-120);
  return `${String(index + 1).padStart(4, "0")}-${flat}.patch`;
}

/**
 * `areas`: the root `REVIEW.md` (dir "") and any per-area ones (A-5); their
 * skip entries combine as core/review-areas.ts says.
 */
export function deterministicPass(diff: string | FilePatch[], areas: readonly ReviewArea[], inputsDir: string): DeterministicResult {
  const all = typeof diff === "string" ? parseDiff(diff) : diff;
  const { included, excluded, softSkips } = applyAreaSkips(all, areas);
  const patchDir = join(inputsDir, "patches");
  mkdirSync(patchDir, { recursive: true });
  const patches = included.map((f, i): PatchFile => {
    const rel = join("patches", patchFileName(i, f.path));
    writeFileSync(join(inputsDir, rel), f.patch);
    const p: PatchFile = {
      path: f.path,
      status: f.status,
      added: count(f, "added"),
      removed: count(f, "removed"),
      lines: f.patch.split("\n").length - 1,
      patchPath: rel,
    };
    if (f.oldPath !== undefined && f.oldPath !== f.path) p.oldPath = f.oldPath;
    return p;
  });
  return { all, included, excluded, softSkips, patches };
}

export interface Chunk {
  name: string;
  /** Directories the chunk covers ("." for the root). */
  dirs: string[];
  files: PatchFile[];
  lines: number;
}

/**
 * Group files by directory and pack whole directories into chunks of at most
 * `maxLines` patch lines; a directory larger than that is split by file. One
 * chunk named "all" when everything fits.
 */
export function chunkByDirectory(patches: readonly PatchFile[], maxLines: number): Chunk[] {
  const total = patches.reduce((n, p) => n + p.lines, 0);
  if (total <= maxLines) {
    return [{ name: "all", dirs: [...new Set(patches.map((p) => dirOf(p.path)))].sort(), files: [...patches], lines: total }];
  }
  const byDir = new Map<string, PatchFile[]>();
  for (const p of patches) {
    const d = dirOf(p.path);
    byDir.set(d, [...(byDir.get(d) ?? []), p]);
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | undefined;
  const flush = () => {
    if (cur && cur.files.length > 0) chunks.push(cur);
    cur = undefined;
  };
  const add = (dir: string, files: PatchFile[]) => {
    const lines = files.reduce((n, p) => n + p.lines, 0);
    if (cur && cur.lines + lines > maxLines) flush();
    cur ??= { name: "", dirs: [], files: [], lines: 0 };
    if (!cur.dirs.includes(dir)) cur.dirs.push(dir);
    cur.files.push(...files);
    cur.lines += lines;
  };
  for (const dir of [...byDir.keys()].sort()) {
    const files = byDir.get(dir)!;
    const lines = files.reduce((n, p) => n + p.lines, 0);
    if (lines <= maxLines) {
      add(dir, files);
    } else {
      flush();
      for (const f of files) add(dir, [f]);
      flush();
    }
  }
  flush();
  return chunks.map((c, i) => ({ ...c, name: `chunk-${i + 1}` }));
}

function dirOf(path: string): string {
  const d = dirname(path);
  return d === "" ? "." : d;
}
