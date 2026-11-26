/**
 * Unified diff parsing (S-2): split a PR diff (git format, as GitHub serves
 * it) into per-file patches, with head-side line ranges for the anchor check
 * of mechanical grounding (S-5).
 *
 * Line handling: the diff is split on "\n". A trailing "\r" is stripped from
 * header lines (a CRLF-converted diff), but kept in content lines, where it
 * belongs to the file's own text. Hunk bodies are consumed by the counts in
 * the "@@" header, so content that looks like a header ("--- x", "diff --git")
 * is never mistaken for one.
 */

export type FileStatus = "added" | "deleted" | "modified" | "renamed" | "copied";

/** Inclusive 1-based line range. */
export interface LineRange {
  start: number;
  end: number;
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Head-side lines covered by the hunk (context and added). Empty when newCount is 0. */
  newRange: LineRange | undefined;
  /** Head-side lines this hunk adds, as maximal runs. */
  added: LineRange[];
  /** Base-side lines this hunk removes, as maximal runs. */
  removed: LineRange[];
  /** Whether the base / head side ends without a newline at end of file. */
  oldNoNewlineAtEof: boolean;
  newNoNewlineAtEof: boolean;
}

export interface FilePatch {
  /** Path in the head; for a deleted file, the path it had in the base. */
  path: string;
  /** Path in the base; undefined for an added file. */
  oldPath: string | undefined;
  /** Path in the head; undefined for a deleted file. */
  newPath: string | undefined;
  status: FileStatus;
  binary: boolean;
  /** Rename/copy similarity percentage when given. */
  similarity: number | undefined;
  oldMode: string | undefined;
  newMode: string | undefined;
  hunks: Hunk[];
  /** The exact text of this file's section of the diff, header included. */
  patch: string;
}

export class DiffParseError extends Error {
  override name = "DiffParseError";
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Decode a git C-style quoted path ("a/f\303\251\tx"). Returns undefined if malformed. */
export function unquoteGitPath(s: string): string | undefined {
  if (!s.startsWith('"')) return s;
  if (s.length < 2 || !s.endsWith('"')) return undefined;
  const bytes: number[] = [];
  const body = s.slice(1, -1);
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      for (const b of Buffer.from(c, "utf8")) bytes.push(b);
      continue;
    }
    const n = body[++i];
    if (n === undefined) return undefined;
    if (n in simple) {
      bytes.push(simple[n]!);
    } else if (/[0-7]/.test(n)) {
      const oct = body.slice(i, i + 3);
      if (!/^[0-7]{3}$/.test(oct)) return undefined;
      bytes.push(parseInt(oct, 8));
      i += 2;
    } else {
      return undefined;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Path from a "--- " / "+++ " line: "a/x", "b/x", "/dev/null", possibly quoted, possibly followed by a tab. */
function parseMarkerPath(rest: string): string | null | undefined {
  let p = rest;
  if (!p.startsWith('"')) {
    // git appends a tab when the path contains a space; strip a trailing timestamp/tab part.
    const tab = p.indexOf("\t");
    if (tab >= 0) p = p.slice(0, tab);
  }
  const unq = unquoteGitPath(p);
  if (unq === undefined) return undefined;
  if (unq === "/dev/null") return null;
  return stripPrefix(unq);
}

function stripPrefix(p: string): string {
  return /^[abciwo12]\//.test(p) ? p.slice(2) : p;
}

/** Best effort for "diff --git a/X b/Y" when no ---/+++ lines exist (binary, mode-only, pure rename). */
function parseDiffGitLine(rest: string): { a: string; b: string } | undefined {
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*") (.+)$/.exec(rest);
    if (!m) return undefined;
    const a = unquoteGitPath(m[1]!);
    const b = unquoteGitPath(m[2]!);
    if (a === undefined || b === undefined) return undefined;
    return { a: stripPrefix(a), b: stripPrefix(b) };
  }
  if (rest.endsWith('"')) {
    const idx = rest.lastIndexOf(' "');
    if (idx < 0) return undefined;
    const b = unquoteGitPath(rest.slice(idx + 1));
    if (b === undefined) return undefined;
    return { a: stripPrefix(rest.slice(0, idx)), b: stripPrefix(b) };
  }
  // Unquoted: when both sides are equal, the split is at the middle.
  if ((rest.length - 1) % 2 === 0) {
    const half = (rest.length - 1) / 2;
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (rest[half] === " " && stripPrefix(a) === stripPrefix(b)) return { a: stripPrefix(a), b: stripPrefix(b) };
  }
  const sp = rest.indexOf(" b/");
  if (sp < 0) return undefined;
  return { a: stripPrefix(rest.slice(0, sp)), b: stripPrefix(rest.slice(sp + 1)) };
}

function pushRun(runs: LineRange[], line: number): void {
  const last = runs[runs.length - 1];
  if (last && last.end === line - 1) last.end = line;
  else runs.push({ start: line, end: line });
}

/** Parse a whole PR diff into per-file patches, in diff order. Throws DiffParseError on a malformed hunk. */
export function parseDiff(text: string): FilePatch[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // A diff ending in "\n" yields a final empty element that is not a line.
  if (lines[lines.length - 1] === "") lines.pop();
  const files: FilePatch[] = [];
  let i = 0;

  while (i < lines.length) {
    const header = stripCr(lines[i]!);
    if (!header.startsWith("diff --git ")) {
      i++; // preamble (e.g. "From ..." mail headers) or stray text
      continue;
    }
    const startLine = i;
    const gitPaths = parseDiffGitLine(header.slice("diff --git ".length));
    let oldPath: string | null | undefined;
    let newPath: string | null | undefined;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    let status: FileStatus = "modified";
    let binary = false;
    let similarity: number | undefined;
    let oldMode: string | undefined;
    let newMode: string | undefined;
    const hunks: Hunk[] = [];
    i++;

    // Extended headers.
    for (; i < lines.length; i++) {
      const l = stripCr(lines[i]!);
      if (l.startsWith("diff --git ") || l.startsWith("@@ ") || l.startsWith("--- ")) break;
      let m: RegExpExecArray | null;
      if ((m = /^new file mode (\d+)$/.exec(l))) {
        status = "added";
        newMode = m[1];
      } else if ((m = /^deleted file mode (\d+)$/.exec(l))) {
        status = "deleted";
        oldMode = m[1];
      } else if ((m = /^old mode (\d+)$/.exec(l))) oldMode = m[1];
      else if ((m = /^new mode (\d+)$/.exec(l))) newMode = m[1];
      else if ((m = /^(?:similarity|dissimilarity) index (\d+)%$/.exec(l))) similarity = Number(m[1]);
      else if (l.startsWith("rename from ")) {
        status = "renamed";
        renameFrom = unquoteGitPath(l.slice("rename from ".length));
      } else if (l.startsWith("rename to ")) {
        status = "renamed";
        renameTo = unquoteGitPath(l.slice("rename to ".length));
      } else if (l.startsWith("copy from ")) {
        status = "copied";
        renameFrom = unquoteGitPath(l.slice("copy from ".length));
      } else if (l.startsWith("copy to ")) {
        status = "copied";
        renameTo = unquoteGitPath(l.slice("copy to ".length));
      } else if (l.startsWith("Binary files ") || l === "GIT binary patch") {
        binary = true;
      }
      // "index ..." and anything unknown are ignored.
    }

    // ---/+++ lines.
    if (i < lines.length && stripCr(lines[i]!).startsWith("--- ")) {
      const minus = parseMarkerPath(stripCr(lines[i]!).slice(4));
      const plusLine = lines[i + 1] === undefined ? "" : stripCr(lines[i + 1]!);
      if (!plusLine.startsWith("+++ ")) throw new DiffParseError(`line ${i + 2}: expected "+++" after "---"`);
      const plus = parseMarkerPath(plusLine.slice(4));
      oldPath = minus;
      newPath = plus;
      if (minus === null && status === "modified") status = "added";
      if (plus === null && status === "modified") status = "deleted";
      i += 2;
    }

    // Hunks.
    while (i < lines.length) {
      const l = stripCr(lines[i]!);
      if (!l.startsWith("@@ ")) break;
      const m = HUNK_RE.exec(l);
      if (!m) throw new DiffParseError(`line ${i + 1}: malformed hunk header`);
      const hunk: Hunk = {
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        newRange: undefined,
        added: [],
        removed: [],
        oldNoNewlineAtEof: false,
        newNoNewlineAtEof: false,
      };
      if (hunk.newCount > 0) hunk.newRange = { start: hunk.newStart, end: hunk.newStart + hunk.newCount - 1 };
      i++;
      let oldLeft = hunk.oldCount;
      let newLeft = hunk.newCount;
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      let lastKind = "";
      while (oldLeft > 0 || newLeft > 0 || (i < lines.length && lines[i]!.startsWith("\\"))) {
        const raw = lines[i];
        if (raw === undefined) throw new DiffParseError(`hunk at line ${i} is truncated`);
        const kind = raw[0];
        if (kind === "\\") {
          // "\ No newline at end of file" applies to the previous line.
          if (lastKind === "-") hunk.oldNoNewlineAtEof = true;
          else if (lastKind === "+") hunk.newNoNewlineAtEof = true;
          else {
            hunk.oldNoNewlineAtEof = true;
            hunk.newNoNewlineAtEof = true;
          }
          i++;
          continue;
        }
        if (kind === "+") {
          if (newLeft === 0) throw new DiffParseError(`line ${i + 1}: more added lines than the hunk header says`);
          pushRun(hunk.added, newLine++);
          newLeft--;
        } else if (kind === "-") {
          if (oldLeft === 0) throw new DiffParseError(`line ${i + 1}: more removed lines than the hunk header says`);
          pushRun(hunk.removed, oldLine++);
          oldLeft--;
        } else if (kind === " " || raw === "" || raw === "\r") {
          // An empty line is a context line whose leading space was stripped (some tools do this).
          if (oldLeft === 0 || newLeft === 0) throw new DiffParseError(`line ${i + 1}: context line beyond the hunk`);
          oldLine++;
          newLine++;
          oldLeft--;
          newLeft--;
        } else {
          throw new DiffParseError(`line ${i + 1}: unexpected line in hunk`);
        }
        lastKind = kind ?? " ";
        i++;
      }
      hunks.push(hunk);
    }
    if (i < lines.length && !stripCr(lines[i]!).startsWith("diff --git ")) {
      // Hunk counts are exhausted, so anything else here means the header lied.
      throw new DiffParseError(`line ${i + 1}: unexpected line after the last hunk of ${header}`);
    }

    // Resolve paths: ---/+++ win, then rename/copy headers, then the diff --git line.
    if (renameFrom !== undefined && oldPath === undefined) oldPath = renameFrom;
    if (renameTo !== undefined && newPath === undefined) newPath = renameTo;
    if (oldPath === undefined && status !== "added") oldPath = gitPaths?.a;
    if (newPath === undefined && status !== "deleted") newPath = gitPaths?.b;
    const o = oldPath ?? undefined;
    const n = newPath ?? undefined;
    const path = n ?? o;
    if (path === undefined) throw new DiffParseError(`line ${startLine + 1}: cannot determine the file path`);
    if (status === "added" || status === "deleted") {
      // keep
    } else if (o !== undefined && n !== undefined && o !== n && status === "modified") {
      status = "renamed";
    }

    const patch = lines.slice(startLine, i).join("\n") + "\n";
    files.push({
      path,
      oldPath: status === "added" ? undefined : o,
      newPath: status === "deleted" ? undefined : n,
      status,
      binary,
      similarity,
      oldMode,
      newMode,
      hunks,
      patch,
    });
  }
  return files;
}

/** Head-side lines the diff adds in this file, as maximal runs. */
export function changedRanges(file: FilePatch): LineRange[] {
  return file.hunks.flatMap((h) => h.added.map((r) => ({ ...r })));
}

/** Index of head-side diff ranges per head path, for anchor checks (S-5). */
export interface DiffIndex {
  /** Head path → head-side hunk ranges. Deleted and binary files have none. */
  hunks: Map<string, LineRange[]>;
  /** Head path → added-line ranges. */
  changed: Map<string, LineRange[]>;
}

export function indexDiff(files: readonly FilePatch[]): DiffIndex {
  const hunks = new Map<string, LineRange[]>();
  const changed = new Map<string, LineRange[]>();
  for (const f of files) {
    if (f.newPath === undefined) continue;
    hunks.set(f.newPath, f.hunks.flatMap((h) => (h.newRange ? [h.newRange] : [])));
    changed.set(f.newPath, changedRanges(f));
  }
  return { hunks, changed };
}

function overlaps(a: LineRange, b: LineRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/**
 * Is a head-side anchor inside the diff? True when the range overlaps the
 * head side of any hunk of that file (lines GitHub can comment on).
 * Reading chosen for R-1: overlap, not containment, so a finding that starts
 * on context just above a change still counts as in the diff.
 */
export function isInDiff(index: DiffIndex, path: string, startLine: number, endLine: number): boolean {
  const ranges = index.hunks.get(path);
  if (!ranges) return false;
  const r = { start: startLine, end: Math.max(startLine, endLine) };
  return ranges.some((h) => overlaps(h, r));
}

/**
 * The anchor as GitHub can take it (S-5, S-7): the part of the range inside
 * the first hunk it overlaps, or undefined when it overlaps none. GitHub
 * rejects a multi-line comment whose start or end is not a diff line of one
 * hunk, and with it the whole review; a model's range often runs past a
 * hunk or past the end of a new file.
 */
export function clampToDiff(index: DiffIndex, path: string, startLine: number, endLine: number): LineRange | undefined {
  const ranges = index.hunks.get(path);
  if (!ranges) return undefined;
  const r = { start: startLine, end: Math.max(startLine, endLine) };
  const h = ranges.find((x) => overlaps(x, r));
  return h ? { start: Math.max(h.start, r.start), end: Math.min(h.end, r.end) } : undefined;
}

/** Does the range overlap a line this diff adds? */
export function touchesChangedLines(index: DiffIndex, path: string, startLine: number, endLine: number): boolean {
  const ranges = index.changed.get(path);
  if (!ranges) return false;
  const r = { start: startLine, end: Math.max(startLine, endLine) };
  return ranges.some((h) => overlaps(h, r));
}
