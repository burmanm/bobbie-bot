import { test } from "node:test";
import assert from "node:assert/strict";
import { indexDiff, parseDiff } from "./diff.ts";
import type { FileLookup } from "./fingerprint.ts";
import { applyVerdict, groundFindings, quoteFound } from "./grounding.ts";
import { applyNitCap, dedupe, missingStatusReasons, reconcile } from "./reconcile.ts";
import type { Finding } from "./schemas.ts";
import { finding } from "./test-fixtures.ts";

const HEAD_A = "package a\n\nfunc A() {\n\tm[k] = v\n\treturn\n}\n";
const files: Record<string, Record<string, string>> = {
  head: { "pkg/a.go": HEAD_A, "pkg/crlf.go": "one\r\ntwo  three\r\n" },
  base: { "pkg/a.go": "package a\n\nfunc A() {\n\treturn\n}\n" },
  modcache: { "lib@v1.0.0/x.go": "func Do() error { return nil }\n" },
};
const lookup: FileLookup = (root, path) => files[root]?.[path];
const diff = indexDiff(
  parseDiff(
    "diff --git a/pkg/a.go b/pkg/a.go\n--- a/pkg/a.go\n+++ b/pkg/a.go\n@@ -1,5 +1,6 @@\n package a\n \n func A() {\n+\tm[k] = v\n \treturn\n }\n",
  ),
);
const ctx = { diff, lookup };
const at = (path: string, startLine: number, endLine = startLine) => ({ path, startLine, endLine });

test("quote matching: exact lines, whitespace-tolerant, CRLF, roots, out of range", () => {
  const ev = (root: "head" | "base" | "modcache", path: string, s: number, e: number, quote: string) => ({ root, path, startLine: s, endLine: e, quote });
  assert.ok(quoteFound(ev("head", "pkg/a.go", 4, 4, "m[k] = v"), lookup));
  assert.ok(quoteFound(ev("head", "pkg/a.go", 3, 5, "func A() {\n    m[k] = v"), lookup));
  assert.ok(quoteFound(ev("head", "pkg/crlf.go", 2, 2, "two three"), lookup));
  assert.ok(quoteFound(ev("modcache", "lib@v1.0.0/x.go", 1, 1, "return nil"), lookup));
  assert.ok(!quoteFound(ev("head", "pkg/a.go", 5, 5, "m[k] = v"), lookup), "wrong line");
  assert.ok(!quoteFound(ev("base", "pkg/a.go", 4, 4, "m[k] = v"), lookup), "wrong root");
  assert.ok(!quoteFound(ev("head", "pkg/a.go", 4, 99, "m[k] = v"), lookup), "beyond EOF");
  assert.ok(!quoteFound(ev("head", "missing.go", 1, 1, "x"), lookup));
  assert.ok(!quoteFound(ev("head", "pkg/a.go", 3, 5, "func A() {\\n\\tm[k] = v"), lookup), "literal \\n is not a line break");
  assert.ok(!quoteFound(ev("head", "pkg/a.go", 4, 4, "   "), lookup));
});

test("grounding: keeps a grounded in-diff finding unchanged", () => {
  const f = finding();
  const [g] = groundFindings([f], ctx);
  assert.equal(g, f);
});

test("grounding: evidence not found refutes with a reason", () => {
  const f = finding({ evidence: [{ root: "head", path: "pkg/a.go", startLine: 4, endLine: 4, quote: "m[k] = w" }] });
  const [g] = groundFindings([f], ctx);
  assert.equal(g!.status, "refuted");
  assert.equal(g!.statusReason, "evidence not found: head:pkg/a.go:4-4");
});

test("grounding: important/nit outside the diff are re-tagged pre-existing; pre-existing untouched", () => {
  const imp = finding({ locations: [at("pkg/a.go", 20)] });
  const nit = finding({ tag: "nit", locations: [at("pkg/other.go", 1)] });
  const pre = finding({ tag: "pre-existing", locations: [at("pkg/other.go", 1)] });
  const [g1, g2, g3] = groundFindings([imp, nit, pre], ctx);
  assert.equal(g1!.tag, "pre-existing");
  assert.equal(g1!.retaggedFrom, "important");
  assert.equal(g1!.status, "proposed");
  assert.match(g1!.statusReason!, /outside the diff/);
  assert.equal(g2!.retaggedFrom, "nit");
  assert.equal(g3, pre);
});

test("grounding: an anchor running past its hunk is cut to it, so GitHub takes it inline; other locations and the fingerprint stay", () => {
  const f = finding({ locations: [at("pkg/a.go", 4, 12), at("pkg/other.go", 30, 40)] });
  const [g] = groundFindings([f], ctx);
  assert.equal(g!.tag, "important");
  assert.deepEqual(g!.locations, [at("pkg/a.go", 4, 6), at("pkg/other.go", 30, 40)]);
  assert.equal(g!.fingerprint, f.fingerprint);
  const inside = finding({ locations: [at("pkg/a.go", 2, 5)] });
  assert.equal(groundFindings([inside], ctx)[0], inside, "an anchor inside its hunk is the same object");
});

test("grounding: cross-field and schema violations are refuted (defence in depth)", () => {
  const bad = finding({ proposedIssue: "x" });
  const rev = finding({ locations: [at("pkg/a.go", 5, 4)] });
  const [g1, g2] = groundFindings([bad, rev], ctx);
  assert.equal(g1!.status, "refuted");
  assert.match(g1!.statusReason!, /proposedIssue/);
  assert.match(g2!.statusReason!, /before startLine/);
});

test("grounding: only proposed findings are checked", () => {
  const f = finding({ status: "duplicate", statusReason: "x", evidence: [{ root: "head", path: "nope", startLine: 1, endLine: 1, quote: "q" }] });
  assert.equal(groundFindings([f], ctx)[0], f);
});

test("verdicts", () => {
  const f = finding();
  const ev = [{ root: "head" as const, path: "pkg/a.go", startLine: 1, endLine: 1, quote: "package a" }];
  assert.equal(applyVerdict(f, { verdict: "refuted", reasoning: "map is made in NewA", evidence: ev }).status, "refuted");
  assert.equal(applyVerdict(f, { verdict: "confirmed", reasoning: "r", evidence: [] }).status, "verified");
  const inc = applyVerdict(f, { verdict: "inconclusive", reasoning: "needs runtime", evidence: [] });
  assert.equal(inc.status, "unverified");
  assert.match(inc.statusReason!, /inconclusive/);
  const bad = applyVerdict(f, { verdict: "refuted", reasoning: "trust me", evidence: [] });
  assert.equal(bad.status, "unverified", "refutation without evidence does not drop");
  const dropped = finding({ status: "refuted", statusReason: "x" });
  assert.equal(applyVerdict(dropped, { verdict: "confirmed", reasoning: "r", evidence: [] }), dropped);
});

const statuses = (fs: Finding[]) => fs.map((f) => [f.id, f.status]);

test("dedupe: same fingerprint within run, keeping the stronger finding", () => {
  const nit = finding({ id: "n", tag: "nit", fingerprint: "X" });
  const imp = finding({ id: "i", tag: "important", fingerprint: "X", locations: [at("pkg/b.go", 1)] });
  const out = dedupe([nit, imp]);
  assert.deepEqual(statuses(out), [
    ["n", "duplicate"],
    ["i", "proposed"],
  ]);
  assert.equal(out[0]!.statusReason, "duplicate of i (same fingerprint)");
});

test("dedupe: overlapping location with same category; different category is kept", () => {
  const a = finding({ id: "a", locations: [at("pkg/a.go", 3, 6)] });
  const b = finding({ id: "b", locations: [at("pkg/z.go", 1), at("pkg/a.go", 6, 8)] });
  const c = finding({ id: "c", category: "performance", locations: [at("pkg/a.go", 4)] });
  const d = finding({ id: "d", locations: [at("pkg/a.go", 7, 9)] });
  assert.deepEqual(statuses(dedupe([a, b, c, d])), [
    ["a", "proposed"],
    ["b", "duplicate"],
    ["c", "proposed"],
    ["d", "proposed"],
  ]);
});

test("dedupe: verified beats proposed at the same tag", () => {
  const p = finding({ id: "p", fingerprint: "Y" });
  const v = finding({ id: "v", fingerprint: "Y", status: "verified", statusReason: "confirmed by verifier" });
  assert.deepEqual(statuses(dedupe([p, v])), [
    ["p", "duplicate"],
    ["v", "verified"],
  ]);
});

test("dedupe: against prior fingerprints; dropped findings are ignored", () => {
  const posted = finding({ id: "old", fingerprint: "P" });
  const refuted = finding({ id: "r", fingerprint: "Q", status: "refuted", statusReason: "x" });
  const live = finding({ id: "l", fingerprint: "Q", locations: [at("pkg/q.go", 1)] });
  const out = dedupe([posted, refuted, live], new Set(["P"]));
  assert.deepEqual(statuses(out), [
    ["old", "duplicate"],
    ["r", "refuted"],
    ["l", "proposed"],
  ]);
  assert.equal(out[0]!.statusReason, "already raised on this PR (same fingerprint)");
});

test("nit cap: important never capped, pre-existing and dropped nits don't count", () => {
  const fs = [
    finding({ id: "n1", tag: "nit" }),
    finding({ id: "i1" }),
    finding({ id: "d", tag: "nit", status: "duplicate", statusReason: "x" }),
    finding({ id: "n2", tag: "nit" }),
    finding({ id: "p", tag: "pre-existing" }),
    finding({ id: "n3", tag: "nit" }),
    finding({ id: "i2" }),
  ];
  assert.deepEqual(statuses(applyNitCap(fs, 2)), [
    ["n1", "proposed"],
    ["i1", "proposed"],
    ["d", "duplicate"],
    ["n2", "proposed"],
    ["p", "proposed"],
    ["n3", "over-limit"],
    ["i2", "proposed"],
  ]);
  assert.deepEqual(statuses(applyNitCap(fs, 0)).filter(([, s]) => s === "over-limit").length, 3);
  assert.deepEqual(applyNitCap(fs, undefined), fs);
});

test("reconcile = dedupe then cap; every dropped finding has a reason", () => {
  const fs = [
    finding({ id: "n1", tag: "nit", fingerprint: "A", locations: [at("x.go", 1)] }),
    finding({ id: "n1dup", tag: "nit", fingerprint: "A", locations: [at("x.go", 1)] }),
    finding({ id: "n2", tag: "nit", fingerprint: "B", locations: [at("y.go", 1)] }),
  ];
  const out = reconcile(fs, { nitCap: 1 });
  assert.deepEqual(statuses(out), [
    ["n1", "proposed"],
    ["n1dup", "duplicate"],
    ["n2", "over-limit"],
  ]);
  assert.deepEqual(missingStatusReasons(out.filter((f) => f.status !== "proposed")), []);
  assert.deepEqual(missingStatusReasons([finding({ id: "z", status: "refuted" })]), ["z"]);
});
