import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseDiff } from "./diff.ts";
import { applyAreaNitCaps, applyAreaSkips, areaNitCaps, areasFor, candidateAreaDirs, type ReviewArea } from "./review-areas.ts";
import { parseReviewMd } from "./review-md.ts";
import { finding } from "./test-fixtures.ts";

const area = (dir: string, md: string): ReviewArea => ({ dir, path: dir === "" ? "REVIEW.md" : `${dir}/REVIEW.md`, parsed: parseReviewMd(md) });

const root = area("", "## Skip these paths\n- `go.sum`\n\n## Limits\n- At most 3 nits per review.\n");
const api = area("pkg/api", "## Skip these paths\n- `*.pb.go`\n- `/gen/`\n- `fixtures/**` unless the PR is about fixtures\n\n## Limits\n- At most 1 nit.\n");
const deep = area("pkg/api/v2", "## Limits\n- At most 5 nits.\n");

function diffOf(paths: string[]): string {
  return paths.map((p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-a\n+b\n`).join("");
}

describe("per-area REVIEW.md (A-5)", () => {
  test("candidate directories are every proper ancestor of a changed path", () => {
    assert.deepEqual(candidateAreaDirs(["a/b/c.go", "a/d.go", "e.go"]), ["a", "a/b"]);
  });

  test("which files apply: root first, then nearer", () => {
    assert.deepEqual(
      areasFor([deep, api, root], "pkg/api/v2/x.go").map((a) => a.path),
      ["REVIEW.md", "pkg/api/REVIEW.md", "pkg/api/v2/REVIEW.md"],
    );
    assert.deepEqual(areasFor([deep, api, root], "pkg/apix/y.go").map((a) => a.path), ["REVIEW.md"]);
  });

  test("skip entries of an area are relative to its directory and apply only under it; the root's apply everywhere", () => {
    const files = parseDiff(
      diffOf(["go.sum", "pkg/api/go.sum", "pkg/api/x.pb.go", "pkg/api/v2/y.pb.go", "other/z.pb.go", "pkg/api/gen/a.go", "pkg/api/v2/gen/b.go", "pkg/api/fixtures/f.json", "pkg/api/h.go"]),
    );
    const r = applyAreaSkips(files, [root, api]);
    assert.deepEqual(
      Object.fromEntries(r.excluded.map((e) => [e.path, e.reason])),
      {
        "go.sum": 'REVIEW.md "Skip these paths": go.sum',
        "pkg/api/go.sum": 'REVIEW.md "Skip these paths": go.sum',
        "pkg/api/x.pb.go": 'pkg/api/REVIEW.md "Skip these paths": *.pb.go',
        "pkg/api/v2/y.pb.go": 'pkg/api/REVIEW.md "Skip these paths": *.pb.go',
        "pkg/api/gen/a.go": 'pkg/api/REVIEW.md "Skip these paths": /gen/',
      },
    );
    assert.deepEqual(
      r.included.map((f) => f.path),
      ["other/z.pb.go", "pkg/api/v2/gen/b.go", "pkg/api/fixtures/f.json", "pkg/api/h.go"],
    );
    assert.deepEqual(r.softSkips, [{ path: "pkg/api/fixtures/f.json", glob: "fixtures/**", qualifier: "unless the PR is about fixtures", source: "pkg/api/REVIEW.md" }]);
  });

  test("nit caps: the root caps the review, an area caps its own nits; only posted nits count; the strictest wins", () => {
    const nit = (id: string, path: string) => finding({ id, tag: "nit", locations: [{ path, startLine: 1, endLine: 1 }] });
    const fs = [
      nit("a1", "pkg/api/a.go"),
      nit("a2", "pkg/api/b.go"),
      nit("v1", "pkg/api/v2/c.go"),
      nit("o1", "cmd/main.go"),
      nit("o2", "cmd/other.go"),
      finding({ id: "i1", tag: "important", locations: [{ path: "pkg/api/a.go", startLine: 1, endLine: 1 }] }),
    ];
    const out = applyAreaNitCaps(fs, areaNitCaps([root, api, deep]));
    assert.deepEqual(
      out.map((f) => [f.id, f.status, f.statusReason]),
      [
        ["a1", "proposed", undefined],
        ["a2", "over-limit", "over the nit cap of 1 for pkg/api/ from pkg/api/REVIEW.md Limits"],
        ["v1", "over-limit", "over the nit cap of 1 for pkg/api/ from pkg/api/REVIEW.md Limits"],
        ["o1", "proposed", undefined],
        ["o2", "proposed", undefined],
        ["i1", "proposed", undefined],
      ],
    );
    const tight = applyAreaNitCaps(fs, areaNitCaps([area("", "## Limits\n- At most 2 nits.\n"), api]));
    assert.deepEqual(
      tight.filter((f) => f.status === "over-limit").map((f) => [f.id, f.statusReason]),
      [
        ["a2", "over the nit cap of 1 for pkg/api/ from pkg/api/REVIEW.md Limits"],
        ["v1", "over the nit cap of 1 for pkg/api/ from pkg/api/REVIEW.md Limits"],
        ["o2", "over the nit cap of 2 from REVIEW.md Limits"],
      ],
    );
  });
});
