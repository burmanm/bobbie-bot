import { test } from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import {
  Finding,
  OUTPUT_TOOL_SCHEMAS,
  ReportFindingParams,
  validateOutput,
  type ProducerFinding,
} from "./schemas.ts";
import { RunRecord, runMetrics, type StepRecord } from "./run-record.ts";
import { producer } from "./test-fixtures.ts";

test("valid producer finding passes", () => {
  assert.deepEqual(validateOutput("report_finding", producer()), []);
});

test("report_finding rejects orchestrator-owned fields", () => {
  const f = { ...producer(), status: "published" };
  assert.notDeepEqual(validateOutput("report_finding", f), []);
});

test("report_finding rejects bad tag, missing evidence, empty quote", () => {
  assert.notDeepEqual(validateOutput("report_finding", { ...producer(), tag: "critical" }), []);
  assert.notDeepEqual(validateOutput("report_finding", { ...producer(), evidence: [] }), []);
  const p = producer();
  p.evidence[0]!.quote = "";
  assert.notDeepEqual(validateOutput("report_finding", p), []);
});

test("proposedIssue only on pre-existing (cross-field)", () => {
  const bad: ProducerFinding = { ...producer(), proposedIssue: "fix it" };
  assert.match(validateOutput("report_finding", bad).join(), /proposedIssue/);
  const ok: ProducerFinding = { ...producer(), tag: "pre-existing", proposedIssue: "fix it" };
  assert.deepEqual(validateOutput("report_finding", ok), []);
});

test("endLine before startLine is rejected (cross-field)", () => {
  const p = producer();
  p.locations[0] = { path: "a.go", startLine: 5, endLine: 4 };
  assert.match(validateOutput("report_finding", p).join(), /before startLine/);
});

test("refuted verdict needs evidence", () => {
  assert.notDeepEqual(validateOutput("submit_verdict", { verdict: "refuted", reasoning: "x", evidence: [] }), []);
  assert.deepEqual(validateOutput("submit_verdict", { verdict: "confirmed", reasoning: "x", evidence: [] }), []);
});

test("question and needs-human schemas", () => {
  assert.deepEqual(validateOutput("ask_question", { locations: [], body: "Intended?" }), []);
  assert.notDeepEqual(validateOutput("note_needs_human", { what: "x", locations: [], explainedInDescription: true }), []);
  assert.deepEqual(
    validateOutput("note_needs_human", {
      what: "new //nolint",
      locations: [{ path: "a.go", startLine: 1, endLine: 1 }],
      explainedInDescription: false,
    }),
    [],
  );
});

test("producer schemas are plain JSON Schema objects", () => {
  for (const s of Object.values(OUTPUT_TOOL_SCHEMAS)) {
    const json = JSON.parse(JSON.stringify(s));
    assert.equal(json.type, "object");
  }
  const tag = JSON.parse(JSON.stringify(ReportFindingParams)).properties.tag;
  assert.deepEqual(tag.enum, ["important", "nit", "pre-existing"]);
});

test("Finding = producer fields + orchestrator fields", () => {
  const f = { ...producer(), id: "f1", fingerprint: "abc", fingerprintVersion: 1, source: "reviewer:main", status: "proposed" };
  assert.ok(Value.Check(Finding, f));
  assert.ok(!Value.Check(Finding, { ...f, source: "main" }));
});

test("run record validates and metrics count published findings and incomplete usage", () => {
  const base = { ...producer(), fingerprint: "x", fingerprintVersion: 1, source: "reviewer:main" };
  const findings = [
    { ...base, id: "1", status: "published" as const },
    { ...base, id: "2", tag: "nit" as const, status: "over-limit" as const, statusReason: "nit cap 3" },
  ];
  const step = (usageComplete: boolean, cost: number): StepRecord => ({
    name: "review",
    role: "reviewer",
    configuredModel: "p/m",
    servedModels: ["p/m"],
    outcome: usageComplete ? "ok" : "timeout",
    usage: { turns: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: cost, costIsBilled: true, wallMs: 1 },
    usageComplete,
    rejectedCalls: [],
  });
  const steps = [step(true, 0.5), step(false, 0.25)];
  const metrics = runMetrics(findings, steps, 10);
  assert.equal(metrics.published, 1);
  assert.equal(metrics.important, 1);
  assert.equal(metrics.nits, 0);
  assert.equal(metrics.costUsd, 0.75);
  assert.equal(metrics.costUsdCompleteStepsOnly, 0.5);
  assert.equal(metrics.stepsWithIncompleteUsage, 1);
  const record = {
    tool: "review-bot",
    toolVersion: "0.0.0",
    repo: "o/r",
    generatedAt: "2026-11-18T00:00:00Z",
    metrics,
    findings,
    questions: [],
    needsHuman: [],
    run: {
      schemaVersion: 1,
      prNumber: 1,
      baseSha: "b",
      headSha: "h",
      runId: "r",
      startedAt: "t",
      trigger: "pull_request_target",
      scope: "full",
      round: 1,
      versions: { bot: "0.0.0", pi: "1.5.2", methodSkillHash: "m", knowledgeBaseSha: "b", fingerprintVersion: 1, roles: { reviewer: "p/m" } },
      files: [{ path: "a.go", status: "modified", binary: false }],
      knowledgeFiles: ["REVIEW.md"],
      steps,
      result: { checkConclusion: "success", summary: "1 important", publishedCommentIds: [] },
    },
  };
  assert.ok(Value.Check(RunRecord, record), [...Value.Errors(RunRecord, record)].map((e) => e.message).join());
});
