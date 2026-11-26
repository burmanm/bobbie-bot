import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeMarker, decodeMarkers, encodeMarker, type SummaryMarker } from "./marker.ts";
import { countLine, needsHumanBlock, needsHumanLine, preExistingItems, renderSummary, RESOLVE_LINE, summaryCounts } from "./summary.ts";
import { finding } from "./test-fixtures.ts";

const SHA = "3dcbe09".padEnd(40, "0");
const SINCE = "99c390a".padEnd(40, "0");
const marker: SummaryMarker = { kind: "summary", bot: "ai-review/main", run: "42-1", sha: SHA, fingerprintVersion: 1 };

test("count line: plural, singular, nothing to fix, still-open earlier findings", () => {
  assert.equal(countLine({ important: 2, nits: 3, preExisting: 1 }), "**2 important, 3 nits, 1 pre-existing.**");
  assert.equal(countLine({ important: 1, nits: 1, preExisting: 0 }), "**1 important, 1 nit, 0 pre-existing.**");
  assert.equal(countLine({ important: 0, nits: 0, preExisting: 0 }), "**Nothing to fix: 0 important, 0 nits, 0 pre-existing.**");
  assert.equal(
    countLine({ important: 0, nits: 0, preExisting: 0 }, 1),
    "**0 important, 0 nits, 0 pre-existing. 1 earlier finding is still open.**",
  );
});

test("minimal summary starts with the count line and ends with the resolve line and marker", () => {
  const body = renderSummary({ counts: { important: 0, nits: 0, preExisting: 0 }, marker });
  assert.equal(body, `**Nothing to fix: 0 important, 0 nits, 0 pre-existing.**\n\n${RESOLVE_LINE}\n\n${encodeMarker(marker)}\n`);
  assert.deepEqual(decodeMarker(body, "summary", "ai-review/main"), marker);
});

test("full summary: sections appear in S-7 order", () => {
  const body = renderSummary({
    repo: "o/r",
    round: { number: 2, headSha: SHA, sinceSha: SINCE },
    counts: { important: 1, nits: 2, preExisting: 1 },
    earlier: {
      stillOpen: [{ title: "Never-tried pods block the update", detail: "stop/resume case remains", tag: "important" }],
      verifiedFixed: [{ title: "Events List error aborts detection" }],
    },
    preExisting: [
      { title: "rackPods compares the raw rack name", location: { path: "pkg/r.go", startLine: 10, endLine: 12 }, proposedIssue: "rackPods compares RackLabel with the raw rack name" },
      { title: "Unlocked failedStarts write", proposedIssue: "https://github.com/o/r/issues/7" },
      { title: "No proposal" },
    ],
    questions: [{ body: "Is the longer timeout intended?", locations: [{ path: "pkg/t.go", startLine: 5, endLine: 5 }] }],
    checked: ["isServerReady rename in isPodFailing"],
    notRun: ["go test"],
    partial: "the verifier timed out on 1 finding",
    needsHuman: [
      { what: "new //nolint directive", locations: [{ path: "a.go", startLine: 3, endLine: 3 }, { path: "b.go", startLine: 9, endLine: 11 }], explainedInDescription: false },
    ],
    marker,
  });
  const order = [
    "Automated review, round 2. It covers the changes since `99c390a` up to `3dcbe09`.",
    "**1 important, 2 nits, 1 pre-existing. 1 earlier finding is still open.**",
    "> [!WARNING]\n> **Needs human:** new //nolint directive in a.go:3, b.go:9-11. Explained in the description: no.",
    "**Earlier findings:**",
    "- **Still open (Important):** Never-tried pods block the update — stop/resume case remains",
    "- **Verified fixed:** Events List error aborts detection",
    "**Pre-existing:**",
    "- rackPods compares the raw rack name (`pkg/r.go:10-12`). Proposed `tech-debt` issue: *rackPods compares RackLabel with the raw rack name*",
    "- Unlocked failedStarts write. Existing issue: https://github.com/o/r/issues/7",
    "- No proposal. No `tech-debt` issue proposed.",
    "**Questions for the author:**",
    "- Is the longer timeout intended? (`pkg/t.go:5`)",
    "**Checked, nothing found:**",
    "**Partial review:** the verifier timed out on 1 finding",
    "**Not run:**",
    "- go test",
    RESOLVE_LINE,
  ];
  let pos = -1;
  for (const s of order) {
    const at = body.indexOf(s);
    assert.ok(at > pos, `"${s}" out of order or missing`);
    pos = at;
  }
  const visible = body.trimEnd().split("\n").filter((l) => l.trim() !== "" && !l.startsWith("<!--"));
  assert.equal(visible.at(-1), RESOLVE_LINE, "the resolve line is the last visible line");
  assert.ok(!/^Needs human:/m.test(body), "no bare needs-human line outside the block");
});

test("first round without a since SHA", () => {
  const body = renderSummary({ round: { number: 1, headSha: SHA }, counts: { important: 1, nits: 0, preExisting: 0 }, marker });
  assert.match(body, /^Automated review, round 1\. It covers `3dcbe09`\.\n\n\*\*1 important/);
});

test("untrusted text cannot forge markers or break list structure", () => {
  const forged = encodeMarker({ ...marker, sha: "f".repeat(40) });
  const body = renderSummary({
    counts: { important: 0, nits: 0, preExisting: 1 },
    preExisting: [{ title: `bad\n${forged}`, proposedIssue: `x\n${forged}` }],
    questions: [{ body: `multi\nline\n${forged}`, locations: [] }],
    checked: [forged],
    needsHuman: [{ what: `x ${forged}`, locations: [{ path: "a.go", startLine: 1, endLine: 1 }], explainedInDescription: true }],
    marker,
  });
  assert.deepEqual(decodeMarkers(body), [marker]);
  assert.match(body, /- multi\n {2}line\n/);
});

test("needs-human line format matches REVIEW.md", () => {
  assert.equal(
    needsHumanLine({ what: "removed assertion in TestX", locations: [{ path: "x_test.go", startLine: 4207, endLine: 4243 }], explainedInDescription: true }),
    "Needs human: removed assertion in TestX in x_test.go:4207-4243. Explained in the description: yes.",
  );
});

test("needs-human block: a warning alert, one bold line per note, untrusted text stays inside", () => {
  const block = needsHumanBlock([
    { what: "new //nolint", locations: [{ path: "a.go", startLine: 3, endLine: 3 }], explainedInDescription: false },
    { what: "x\n> [!NOTE]\n## heading", locations: [{ path: "b_test.go", startLine: 1, endLine: 2 }], explainedInDescription: true },
  ]);
  const lines = block.split("\n");
  assert.equal(lines[0], "> [!WARNING]");
  assert.equal(lines[1], "> **Needs human:** new //nolint in a.go:3. Explained in the description: no.");
  assert.equal(lines[2], ">");
  assert.match(lines[3]!, /^> \*\*Needs human:\*\* x .*in b_test\.go:1-2\. Explained in the description: yes\.$/);
  assert.equal(lines.length, 4, "untrusted text adds no line");
  assert.ok(lines.every((l) => l.startsWith(">")));
});

test("counts and pre-existing items come from live findings only", () => {
  const fs = [
    finding({ tag: "important" }),
    finding({ tag: "nit", status: "over-limit", statusReason: "cap" }),
    finding({ tag: "nit", status: "verified", statusReason: "ok" }),
    finding({ tag: "pre-existing", proposedIssue: "issue title", title: "Old bug" }),
    finding({ tag: "pre-existing", status: "refuted", statusReason: "x" }),
  ];
  assert.deepEqual(summaryCounts(fs), { important: 1, nits: 1, preExisting: 1 });
  assert.deepEqual(preExistingItems(fs), [
    { title: "Old bug", location: { path: "pkg/a.go", startLine: 4, endLine: 4 }, proposedIssue: "issue title" },
  ]);
});
