import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Value } from "typebox/value";
import * as core from "./index.ts";
import { SavedScripts, ScriptCollector, type ScriptEvent, type ScriptLimits } from "./saved-scripts.ts";

const noScrub = (text: string) => text;

const start = (toolCallId: string, toolName: string, parentToolCallId?: string, args: unknown = {}): ScriptEvent => ({
  type: "tool_execution_start",
  toolCallId,
  toolName,
  args,
  ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
});
const end = (toolCallId: string, toolName: string, isError = false, parentToolCallId?: string): ScriptEvent => ({
  type: "tool_execution_end",
  toolCallId,
  toolName,
  isError,
  ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
});
const script = (id: string, code: unknown = "return 1") => start(id, "codemode", undefined, { code });

function collect(events: ScriptEvent[], limits: Partial<ScriptLimits> = {}, scrub = noScrub) {
  const collector = new ScriptCollector(scrub, limits);
  for (const event of events) collector.record("review", event);
  return collector;
}

function fileOf(collector: ScriptCollector): SavedScripts {
  const file = collector.file();
  assert.ok(file);
  assert.ok(Value.Check(SavedScripts, file), JSON.stringify(Value.Errors(SavedScripts, file)));
  return file;
}

describe("saved scripts (A-6)", () => {
  test("is exported from core", () => {
    assert.equal(core.ScriptCollector, ScriptCollector);
    assert.equal(core.SavedScripts, SavedScripts);
  });

  test("no script, no file", () => {
    assert.equal(new ScriptCollector(noScrub).file(), undefined);
    assert.equal(collect([start("a", "read"), end("a", "read")]).file(), undefined);
  });

  test("a script keeps step, call id, exact source, outcome and nested calls", () => {
    const code = '// @options: {"timeout_ms": 5000}\r\nawait tools.grep({ pattern: "é" });\n';
    const file = fileOf(
      collect([
        script("c", code),
        start("c/1", "grep", "c"),
        start("c/2", "read", "c"),
        end("c/2", "read", true, "c"),
        end("c/1", "grep", false, "c"),
        end("c", "codemode"),
      ]),
    );
    assert.deepEqual(file, {
      schemaVersion: 1,
      droppedScripts: 0,
      scripts: [
        {
          id: "script-1",
          step: "review",
          toolCallId: "c",
          source: code,
          sourceTruncated: false,
          sourceRedacted: false,
          outcome: "ok",
          nestedCalls: [
            { tool: "grep", isError: false },
            { tool: "read", isError: true },
          ],
          nestedTruncated: false,
        },
      ],
    });
  });

  test("outcomes: error, and unfinished calls", () => {
    const file = fileOf(collect([script("a"), end("a", "codemode", true), script("b"), start("b/1", "read", "b")]));
    assert.deepEqual(file.scripts.map((s) => s.outcome), ["error", "unfinished"]);
    assert.deepEqual(file.scripts[1]!.nestedCalls, [{ tool: "read" }]);
  });

  test("a call that ends after its script still gets its flag", () => {
    const file = fileOf(collect([script("c"), start("c/1", "read", "c"), end("c", "codemode"), end("c/1", "read", true, "c")]));
    assert.deepEqual(file.scripts[0]!.nestedCalls, [{ tool: "read", isError: true }]);
  });

  test("no output, results or nested arguments are kept", () => {
    const events = [
      { ...script("c"), extra: "EXTRA-CANARY" },
      start("c/1", "read", "c", { path: "ARGS-CANARY" }),
      { ...end("c/1", "read", false, "c"), result: { content: "RESULT-CANARY" } },
      { ...end("c", "codemode"), result: { content: "OUTPUT-CANARY" } },
    ] as ScriptEvent[];
    assert.doesNotMatch(JSON.stringify(fileOf(collect(events))), /CANARY/);
  });

  test("the schema refuses fields that would carry output or arguments", () => {
    const file = fileOf(collect([script("c"), start("c/1", "read", "c")]));
    const saved = file.scripts[0]!;
    assert.equal(Value.Check(SavedScripts, { ...file, scripts: [{ ...saved, output: "x" }] }), false);
    assert.equal(Value.Check(SavedScripts, { ...file, scripts: [{ ...saved, nestedCalls: [{ tool: "read", args: {} }] }] }), false);
  });

  test("file() is a copy", () => {
    const collector = collect([script("c")]);
    const before = fileOf(collector);
    collector.record("review", end("c", "codemode"));
    assert.equal(before.scripts[0]!.outcome, "unfinished");
    assert.equal(fileOf(collector).scripts[0]!.outcome, "ok");
  });
});

describe("linking a finding to its script (A-6)", () => {
  test("a call from a script, at any depth, has the script's id", () => {
    const collector = collect([script("a"), script("c"), start("c/1", "outer", "c"), start("c/1/4", "inner", "c/1"), start("c/1/4/2", "report", "c/1/4")]);
    for (const parent of ["c", "c/1", "c/1/4"]) assert.equal(collector.scriptIdOf("review", parent), "script-2");
    assert.equal(collector.scriptIdOf("review", "a"), "script-1");
    assert.deepEqual(fileOf(collector).scripts[1]!.nestedCalls.map((c) => c.tool), ["outer", "inner", "report"]);
  });

  test("calls that are not from a script have none", () => {
    const collector = collect([script("c"), start("other", "subagent"), start("other/1", "report", "other")]);
    for (const parent of [undefined, "other", "other/1", "cc/1", "c/x", "c/1x"]) assert.equal(collector.scriptIdOf("review", parent), undefined);
    assert.deepEqual(fileOf(collector).scripts[0]!.nestedCalls, []);
  });

  test("provider ids that contain slashes and digits", () => {
    const collector = collect([script("call|ab/12"), script("call|ab")]);
    assert.equal(collector.scriptIdOf("review", "call|ab/12/3"), "script-1");
    assert.equal(collector.scriptIdOf("review", "call|ab/3"), "script-2");
  });

  test("steps have their own call ids", () => {
    const collector = new ScriptCollector(noScrub);
    collector.record("review", script("c"));
    collector.record("verify:f1", script("c"));
    collector.record("verify:f1", end("c", "codemode", true));
    assert.equal(collector.scriptIdOf("review", "c/1"), "script-1");
    assert.equal(collector.scriptIdOf("verify:f1", "c/1"), "script-2");
    assert.equal(collector.scriptIdOf("verify:f2", "c/1"), undefined);
    assert.deepEqual(fileOf(collector).scripts.map((s) => [s.step, s.outcome]), [["review", "unfinished"], ["verify:f1", "error"]]);
  });

  test("a call id reused in a later turn", () => {
    const collector = collect([script("call_0"), end("call_0", "codemode"), script("call_0")]);
    assert.equal(collector.scriptIdOf("review", "call_0"), "script-2");
    collector.record("review", end("call_0", "codemode", true));
    collector.record("review", start("call_0", "subagent"));
    collector.record("review", end("call_0", "subagent"));
    assert.equal(collector.scriptIdOf("review", "call_0"), undefined);
    assert.deepEqual(fileOf(collector).scripts.map((s) => s.outcome), ["ok", "error"]);
  });
});

describe("caps and redaction (A-6, C-7)", () => {
  test("source is cut on a character boundary and marked", () => {
    const file = fileOf(collect([script("c", "é".repeat(10))], { maxSourceBytes: 5 }));
    assert.equal(file.scripts[0]!.source, "éé");
    assert.equal(file.scripts[0]!.sourceTruncated, true);
    const exact = fileOf(collect([script("c", "12345")], { maxSourceBytes: 5 })).scripts[0]!;
    assert.deepEqual([exact.source, exact.sourceTruncated], ["12345", false]);
    assert.equal(fileOf(collect([script("c", "﻿abcdef")], { maxSourceBytes: 5 })).scripts[0]!.source, "﻿ab");
  });

  test("redaction is marked, and happens before the cut", () => {
    const scrub = (text: string) => text.replaceAll("HUSH-HUSH", "[redacted]");
    const saved = fileOf(collect([script("HUSH-HUSH", "xxxxHUSH-HUSH")], { maxSourceBytes: 8 }, scrub)).scripts[0]!;
    assert.equal(saved.source, "xxxx[red");
    assert.equal(saved.sourceRedacted, true);
    assert.equal(saved.toolCallId, "[redacted]");
    const literal = fileOf(collect([script("c", "log('[redacted]')")], {}, scrub)).scripts[0]!;
    assert.equal(literal.sourceRedacted, false);
  });

  test("a nested tool name is scrubbed and cut", () => {
    const scrub = (text: string) => text.replaceAll("HUSH", "[redacted]");
    const saved = fileOf(collect([script("c"), start("c/1", `HUSH${"n".repeat(5_000)}`, "c")], {}, scrub)).scripts[0]!;
    assert.match(saved.nestedCalls[0]!.tool, /^\[redacted\]n+$/);
    assert.equal(saved.nestedCalls[0]!.tool.length, 512);
  });

  test("a call without source text is saved and marked", () => {
    for (const args of [undefined, null, "code", {}, { code: 7 }]) {
      const saved = fileOf(collect([start("c", "codemode", undefined, args)])).scripts[0]!;
      assert.deepEqual([saved.source, saved.sourceTruncated], ["", true]);
    }
  });

  test("nested calls are capped per script and marked", () => {
    const calls = [1, 2, 3].flatMap((n) => [start(`c/${n}`, `t${n}`, "c"), end(`c/${n}`, `t${n}`, false, "c")]);
    const [first, second] = fileOf(collect([script("c"), ...calls, script("d"), start("d/1", "t", "d")], { maxNestedCalls: 2 })).scripts;
    assert.deepEqual(first!.nestedCalls.map((c) => c.tool), ["t1", "t2"]);
    assert.equal(first!.nestedTruncated, true);
    assert.equal(second!.nestedTruncated, false);
  });

  test("a script over the total is dropped and counted, and still links", () => {
    const collector = collect([script("a"), script("b", "x".repeat(2_000)), script("c")], { maxTotalBytes: 1_000 });
    const file = fileOf(collector);
    assert.deepEqual(file.scripts.map((s) => s.id), ["script-1", "script-3"]);
    assert.equal(file.droppedScripts, 1);
    assert.equal(collector.scriptIdOf("review", "b/1"), "script-2");
  });

  test("a file with every script dropped is still written", () => {
    assert.deepEqual(fileOf(collect([script("a")], { maxTotalBytes: 10 })), { schemaVersion: 1, scripts: [], droppedScripts: 1 });
  });

  test("the file never exceeds the total, whatever fills it", () => {
    for (const code of ["x", "\u0000".repeat(200), "\u{1F600}\"\\\n".repeat(60)]) {
      for (let maxTotalBytes = 300; maxTotalBytes < 3_000; maxTotalBytes += 13) {
        const events = [1, 2, 3, 4].flatMap((s) => [
          script(`c${s}`, code),
          ...Array.from({ length: 12 }, (_, n) => [start(`c${s}/${n}`, "grep", `c${s}`), end(`c${s}/${n}`, "grep", n % 2 === 0, `c${s}`)]).flat(),
          end(`c${s}`, "codemode", s % 2 === 0),
        ]);
        const file = fileOf(collect(events, { maxTotalBytes }));
        assert.ok(Buffer.byteLength(JSON.stringify(file)) <= maxTotalBytes, `over ${maxTotalBytes}`);
      }
    }
  });
});
