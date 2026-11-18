import { test } from "node:test";
import assert from "node:assert/strict";
import { FINGERPRINT_VERSION, anchorCode, fingerprint, fingerprintFinding, normalizeAnchor, sliceLines, type FileLookup } from "./fingerprint.ts";
import { decodeMarker, decodeMarkers, encodeMarker, MarkerError, neutralizeMarkers, type Marker } from "./marker.ts";
import { producer } from "./test-fixtures.ts";

test("fingerprint is stable across whitespace and line shifts, sensitive to path/category/code", () => {
  const a = fingerprint("a.go", "correctness", "if x {\n\treturn\n}");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, fingerprint("a.go", "correctness", "  if x {\r\n    return\r\n  }  "));
  assert.notEqual(a, fingerprint("b.go", "correctness", "if x { return }"));
  assert.notEqual(a, fingerprint("a.go", "concurrency", "if x { return }"));
  assert.notEqual(a, fingerprint("a.go", "correctness", "if y { return }"));
  assert.equal(FINGERPRINT_VERSION, 1);
  assert.equal(normalizeAnchor(" a \t\n b "), "a b");
});

test("fingerprint inputs cannot collide by concatenation", () => {
  assert.notEqual(fingerprint("a", "docs", "b c"), fingerprint("a b", "docs", "c"));
});

test("sliceLines handles CRLF, trailing newline, no trailing newline, out of range", () => {
  assert.deepEqual(sliceLines("a\r\nb\r\nc\r\n", 2, 3), ["b", "c"]);
  assert.deepEqual(sliceLines("a\nb", 2, 2), ["b"]);
  assert.equal(sliceLines("a\nb\n", 3, 3), undefined);
  assert.equal(sliceLines("a\n", 0, 1), undefined);
  assert.equal(sliceLines("a\nb\n", 2, 1), undefined);
});

test("fingerprintFinding reads the anchor from head; same code moved keeps the fingerprint", () => {
  const v1: FileLookup = (root, path) => (root === "head" && path === "pkg/a.go" ? "x\ny\nz\nm[k] = v\n" : undefined);
  const v2: FileLookup = (root, path) => (root === "head" && path === "pkg/a.go" ? "x\ny\nnew\n\n  m[k]  =  v\n" : undefined);
  const f1 = producer();
  const f2 = producer({ locations: [{ path: "pkg/a.go", startLine: 5, endLine: 5 }] });
  assert.equal(anchorCode(f1, v1), "m[k] = v");
  assert.equal(fingerprintFinding(f1, v1), fingerprintFinding(f2, v2));
});

test("fingerprintFinding falls back to the title when the anchor cannot be read", () => {
  const none: FileLookup = () => undefined;
  assert.equal(anchorCode(producer(), none), "title:Nil map write");
  const blank: FileLookup = () => "\n\n\n";
  assert.equal(anchorCode(producer(), blank), "title:Nil map write");
});

const FP = "a".repeat(64);
const SHA = "0123456789abcdef0123456789abcdef01234567";
const fm: Marker = { kind: "finding", bot: "ai-review/main", run: "123-1", fingerprint: FP, fingerprintVersion: 1 };
const sm: Marker = { kind: "summary", bot: "ai-review/main", run: "123-1", sha: SHA, fingerprintVersion: 1 };

test("marker round trip", () => {
  const enc = encodeMarker(fm);
  assert.equal(enc, `<!-- review-bot:finding bot=ai-review/main run=123-1 fp=${FP} fpv=1 -->`);
  assert.deepEqual(decodeMarkers(`**Important** text\n\n${enc}\n`), [fm]);
  assert.deepEqual(decodeMarker(`summary\r\n${encodeMarker(sm)}\r\n`, "summary", "ai-review/main"), sm);
});

test("encode refuses values that could break out of the comment", () => {
  assert.throws(() => encodeMarker({ ...fm, bot: "x -->" }), MarkerError);
  assert.throws(() => encodeMarker({ ...fm, run: "a b" }), MarkerError);
  assert.throws(() => encodeMarker({ ...fm, fingerprint: "zz" }), MarkerError);
  assert.throws(() => encodeMarker({ ...sm, sha: "HEAD" }), MarkerError);
  assert.throws(() => encodeMarker({ ...fm, fingerprintVersion: 0 }), MarkerError);
});

test("decode is defensive against malicious or malformed text", () => {
  const enc = encodeMarker(fm);
  const bad: unknown[] = [
    undefined,
    null,
    42,
    { body: enc },
    `inline ${enc} text`, // not on its own line
    `> ${enc}`, // quoted in a reply
    "```\n" + enc + "\n```", // inside a code block
    "~~~~\n" + enc + "\n~~~~",
    enc.replace("fpv=1", "fpv=1 fpv=2"), // duplicate key
    enc.replace("fpv=1", "fpv=1 sha=" + SHA), // key not allowed for kind
    enc.replace(" fpv=1", ""), // missing key
    enc.replace(FP, FP.toUpperCase()),
    enc.replace("fpv=1", "fpv=01"),
    enc.replace("fpv=1", "fpv=1e3"),
    enc.replace("review-bot:finding", "review-bot:admin"),
    enc.replace("bot=ai-review/main", "bot=" + "x".repeat(500)),
    enc.replace("bot=ai-review/main", "bot=ai-review/main<script>"),
    enc.replace(" -->", "-->"),
    "<!-- review-bot:finding bot=a run=b fp=" + FP + " fpv=1 --> <!-- extra -->",
    "<!-- review-bot:finding bot=a run=b fp=" + FP + " fpv=1 -->",
    "<!-- review-bot:finding bot=__proto__ run=constructor fp=" + FP + " fpv=1 -->",
  ];
  for (const b of bad) assert.deepEqual(decodeMarkers(b), [], String(b));
});

test("decodeMarker refuses ambiguity and other bots", () => {
  const two = `${encodeMarker(fm)}\n${encodeMarker({ ...fm, run: "999" })}`;
  assert.equal(decodeMarker(two, "finding", "ai-review/main"), undefined);
  assert.equal(decodeMarker(encodeMarker(fm), "finding", "ai-review/security"), undefined);
  assert.equal(decodeMarker(encodeMarker(fm), "summary", "ai-review/main"), undefined);
});

test("decodeMarkers is bounded on huge input", () => {
  const body = Array.from({ length: 1000 }, () => encodeMarker(fm)).join("\n");
  assert.equal(decodeMarkers(body).length, 20);
  assert.deepEqual(decodeMarkers("<!--".repeat(100000)), []);
});

test("neutralizeMarkers stops model text from forging a marker", () => {
  const forged = `nice\n${encodeMarker(sm)}`;
  assert.deepEqual(decodeMarkers(neutralizeMarkers(forged)), []);
});
