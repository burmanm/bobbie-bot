import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clampToDiff, DiffParseError, indexDiff, isInDiff, parseDiff, touchesChangedLines, unquoteGitPath } from "./diff.ts";

// Generated with `git diff --cached -M` over a scratch repository.
const fixture = readFileSync(new URL("./fixtures/pr.diff", import.meta.url), "utf8");
const files = parseDiff(fixture);
const byPath = new Map(files.map((f) => [f.path, f]));

test("splits into one patch per file, in order", () => {
  assert.deepEqual(
    files.map((f) => f.path),
    ["a.go", "added.go", "bin.dat", "crlf.txt", "deleted.txt", "dir/t\tab.txt", "eof.txt", "pure2.txt", "renamed.txt", "run.sh", "with space.txt"],
  );
  assert.equal(files.map((f) => f.patch).join(""), fixture);
});

test("modified file: head-side changed and hunk ranges", () => {
  const f = byPath.get("a.go")!;
  assert.equal(f.status, "modified");
  assert.equal(f.oldPath, "a.go");
  assert.deepEqual(f.hunks[0]!.added, [{ start: 4, end: 4 }]);
  assert.deepEqual(f.hunks[0]!.newRange, { start: 1, end: 6 });
});

test("added and deleted files", () => {
  const a = byPath.get("added.go")!;
  assert.equal(a.status, "added");
  assert.equal(a.oldPath, undefined);
  assert.deepEqual(a.hunks[0]!.added, [{ start: 1, end: 2 }]);
  const d = byPath.get("deleted.txt")!;
  assert.equal(d.status, "deleted");
  assert.equal(d.newPath, undefined);
  assert.equal(d.hunks[0]!.newRange, undefined);
  assert.deepEqual(d.hunks[0]!.removed, [{ start: 1, end: 1 }]);
});

test("renames with and without content changes", () => {
  const pure = byPath.get("pure2.txt")!;
  assert.equal(pure.status, "renamed");
  assert.equal(pure.oldPath, "pure.txt");
  assert.equal(pure.similarity, 100);
  assert.equal(pure.hunks.length, 0);
  const r = byPath.get("renamed.txt")!;
  assert.equal(r.status, "renamed");
  assert.equal(r.oldPath, "moved.txt");
  assert.deepEqual(r.hunks[0]!.added, [{ start: 5, end: 5 }]);
  assert.deepEqual(r.hunks[0]!.removed, [{ start: 5, end: 5 }]);
});

test("binary and mode-only changes", () => {
  const b = byPath.get("bin.dat")!;
  assert.equal(b.binary, true);
  assert.equal(b.hunks.length, 0);
  const m = byPath.get("run.sh")!;
  assert.equal(m.status, "modified");
  assert.equal(m.oldMode, "100644");
  assert.equal(m.newMode, "100755");
  assert.equal(m.binary, false);
});

test("no newline at end of file", () => {
  const h = byPath.get("eof.txt")!.hunks[0]!;
  assert.equal(h.oldNoNewlineAtEof, true);
  assert.equal(h.newNoNewlineAtEof, true);
  assert.deepEqual(h.added, [{ start: 1, end: 1 }]);
});

test("CRLF file content keeps its \\r in the patch", () => {
  const f = byPath.get("crlf.txt")!;
  assert.deepEqual(f.hunks[0]!.added, [{ start: 2, end: 2 }]);
  assert.match(f.patch, /\+CRLF2\r\n/);
});

test("whole diff converted to CRLF still parses", () => {
  const crlf = parseDiff(fixture.replace(/\r?\n/g, "\r\n"));
  assert.deepEqual(
    crlf.map((f) => [f.path, f.status]),
    files.map((f) => [f.path, f.status]),
  );
});

test("quoted and spaced paths", () => {
  assert.ok(byPath.has("dir/t\tab.txt"));
  assert.equal(byPath.get("with space.txt")!.hunks[0]!.added[0]!.start, 2);
  assert.equal(unquoteGitPath('"a/caf\\303\\251"'), "a/café");
  assert.equal(unquoteGitPath('"a/bad\\q"'), undefined);
});

test("content lines that look like headers are not headers", () => {
  const diff = [
    "diff --git a/x.md b/x.md",
    "--- a/x.md",
    "+++ b/x.md",
    "@@ -1,2 +1,2 @@",
    "--- old heading",
    "+diff --git a/y b/y",
    " @@ -1 +1 @@",
    "",
  ].join("\n");
  const [f, ...rest] = parseDiff(diff);
  assert.equal(rest.length, 0);
  assert.deepEqual(f!.hunks[0]!.removed, [{ start: 1, end: 1 }]);
  assert.deepEqual(f!.hunks[0]!.added, [{ start: 1, end: 1 }]);
});

test("omitted hunk counts default to 1; multiple hunks", () => {
  const diff = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "-a", "+b", "@@ -10,0 +11,2 @@", "+c", "+d", ""].join("\n");
  const [f] = parseDiff(diff);
  assert.deepEqual(
    f!.hunks.map((h) => h.added),
    [[{ start: 1, end: 1 }], [{ start: 11, end: 12 }]],
  );
});

test("empty diff and preamble", () => {
  assert.deepEqual(parseDiff(""), []);
  assert.equal(parseDiff("From abc Mon Sep 17 00:00:00 2001\nSubject: x\n\n" + fixture).length, files.length);
});

test("malformed or truncated hunks throw", () => {
  assert.throws(() => parseDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n"), DiffParseError);
  assert.throws(() => parseDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ bogus @@\n"), DiffParseError);
  assert.throws(() => parseDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n+c\n"), DiffParseError);
});

test("anchor inside the diff", () => {
  const idx = indexDiff(files);
  assert.equal(isInDiff(idx, "a.go", 4, 4), true);
  assert.equal(isInDiff(idx, "a.go", 6, 9), true, "overlap with hunk counts");
  assert.equal(isInDiff(idx, "a.go", 7, 9), false);
  assert.equal(isInDiff(idx, "renamed.txt", 1, 1), false);
  assert.equal(isInDiff(idx, "renamed.txt", 2, 2), true);
  assert.equal(isInDiff(idx, "moved.txt", 5, 5), false, "base path of a rename is not a head path");
  assert.equal(isInDiff(idx, "deleted.txt", 1, 1), false);
  assert.equal(isInDiff(idx, "pure2.txt", 1, 1), false);
  assert.equal(isInDiff(idx, "nope.go", 1, 1), false);
  assert.deepEqual(clampToDiff(idx, "a.go", 6, 9), { start: 6, end: 6 }, "cut at the hunk's end");
  assert.deepEqual(clampToDiff(idx, "a.go", 4, 4), { start: 4, end: 4 });
  assert.equal(clampToDiff(idx, "a.go", 7, 9), undefined);
  assert.equal(clampToDiff(idx, "deleted.txt", 1, 1), undefined);
  assert.equal(touchesChangedLines(idx, "a.go", 3, 3), false);
  assert.equal(touchesChangedLines(idx, "a.go", 3, 4), true);
});
