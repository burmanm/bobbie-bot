/**
 * The mandatory isolation regression test (C-3a, D-15). Runs on every pi
 * upgrade (F-6).
 *
 * A snapshot plants hostile `.pi/` settings, an extension, skills, prompts
 * and system-prompt files, `AGENTS.md`/`CLAUDE.md` in the snapshot and its
 * parents, escaping symlinks and ignore files that hide code; the user-level
 * pi directory and home directory are hostile too. A real SDK step runs
 * against pi's scripted model, which records exactly what it was sent.
 */
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createPiSdkAgentStep } from "./pi-sdk-step.ts";
import {
  buildHostileSnapshot,
  CANARIES,
  declaredToolsIn,
  type HostileLayout,
  MARKERS,
  noteTool,
  type SeenToolResult,
  toolResultsIn,
} from "./testing.ts";
import type { AgentStepResult, ReadToolName } from "./types.ts";

const READ: ReadToolName[] = ["read", "grep", "find", "ls"];
const OUTSIDE = "outside the allowed read roots";

let layout: HostileLayout;
const savedEnv = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };

before(() => {
  layout = buildHostileSnapshot();
  // Hostile user-level configuration: if the step fell back to the default
  // agent directory or the home directory, these would load.
  process.env.HOME = layout.home;
  process.env.PI_CODING_AGENT_DIR = layout.userAgentDir;
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(layout.work, { recursive: true, force: true });
});

function assertNoCanary(text: string, where: string): void {
  for (const [name, canary] of Object.entries(CANARIES)) {
    assert.ok(!text.includes(canary), `${name} canary reached the model via ${where}`);
  }
}

describe("control: the fixture is hostile", () => {
  // Proves the snapshot would compromise a default session, so the isolated
  // test below cannot pass vacuously after a pi change.
  test("a default SDK session loads the planted extension, settings and AGENTS.md", async () => {
    const control = buildHostileSnapshot();
    try {
      const faux = fauxProvider();
      const modelRuntime = await ModelRuntime.create({ modelsPath: null, authPath: `${control.work}/auth.json` });
      modelRuntime.registerNativeProvider(faux.provider);
      const { session, extensionsResult } = await createAgentSession({
        cwd: control.head,
        agentDir: control.userAgentDir,
        modelRuntime,
        model: faux.getModel(),
        sessionManager: SessionManager.inMemory(control.head),
      });
      try {
        assert.ok(existsSync(control.plantedRanFile), "planted extension did not run in the control");
        assert.ok(extensionsResult.extensions.some((e) => e.path.endsWith("planted.ts")));
        assert.ok(session.getActiveToolNames().includes("bash"), "snapshot .pi/settings.json not applied in the control");
        assert.ok(session.systemPrompt.includes(CANARIES.snapshotAgentsOverride) || session.systemPrompt.includes(CANARIES.snapshotAgents));
        assert.ok(session.systemPrompt.includes(CANARIES.systemMd));
      } finally {
        session.dispose();
      }
    } finally {
      rmSync(control.work, { recursive: true, force: true });
    }
  });

  test("ripgrep with default flags hides the git-ignored file in this snapshot", async () => {
    // The fixture's .git entry and .gitignore really do hide a file from a
    // search that honours them (spike-r0-findings §5).
    const faux = fauxProvider();
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, authPath: `${layout.work}/control-auth.json` });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
    const resourceLoader = new DefaultResourceLoader({
      cwd: layout.head,
      agentDir: `${layout.work}/control-agent`,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "control",
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: layout.head,
      agentDir: `${layout.work}/control-agent`,
      modelRuntime,
      model: faux.getModel(),
      tools: ["grep"],
      sessionManager: SessionManager.inMemory(layout.head),
      settingsManager,
      resourceLoader,
    });
    let seen: SeenToolResult[] = [];
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("grep", { pattern: MARKERS.gitignored })], { stopReason: "toolUse" }),
      (context) => {
        seen = toolResultsIn(context);
        return fauxAssistantMessage(fauxText("DONE"));
      },
    ]);
    try {
      await session.prompt("control", { expandPromptTemplates: false });
    } finally {
      session.dispose();
    }
    assert.equal(seen.length, 1);
    assert.ok(!seen[0]!.text.includes("hidden.go"), `pi's grep found the ignored file: ${seen[0]!.text}`);
  });
});

describe("isolated step on the hostile snapshot", () => {
  const contexts: unknown[] = [];
  let result: AgentStepResult<typeof noteTool>;
  const byId = new Map<string, SeenToolResult>();

  type Call = [id: string, tool: string, args: Record<string, string>];
  const escapes: Call[] = [];
  const legit: Call[] = [];
  // The control test runs planted code in this process on purpose.
  let plantedBefore: unknown;

  before(async () => {
    const { head, base, modcache, outsideSecret, outsideDir, work } = layout;
    escapes.push(
      ["e-abs", "read", { path: "/etc/hosts" }],
      ["e-abs-secret", "read", { path: outsideSecret }],
      ["e-dotdot", "read", { path: "../../outside-secret.txt" }],
      ["e-at-dotdot", "read", { path: "@../../outside-secret.txt" }],
      ["e-tilde", "read", { path: "~/.ssh/id_rsa" }],
      ["e-tilde-bare", "ls", { path: "~" }],
      ["e-file-url", "read", { path: `file://${outsideSecret}` }],
      ["e-link", "read", { path: "escape-link" }],
      ["e-link-dir", "read", { path: "escape-dir/secret.go" }],
      ["e-base-link", "read", { path: `${base}/base-escape` }],
      ["e-base-dotdot", "read", { path: `${base}/../../outside-secret.txt` }],
      ["e-modcache-dotdot", "read", { path: `${modcache}/../../outside-secret.txt` }],
      ["e-grep-dotdot", "grep", { pattern: MARKERS.outside, path: ".." }],
      ["e-grep-abs", "grep", { pattern: MARKERS.outside, path: outsideDir }],
      ["e-ls-root", "ls", { path: "/" }],
      ["e-ls-link-dir", "ls", { path: "escape-dir" }],
      ["e-find-work", "find", { pattern: "*.go", path: work }],
      ["e-find-link-dir", "find", { pattern: "*.go", path: "escape-dir" }],
    );
    legit.push(
      ["l-read-head", "read", { path: "main.go" }],
      ["l-read-head-abs", "read", { path: `${head}/main.go` }],
      ["l-read-inside-link", "read", { path: "inside-link" }],
      ["l-read-base", "read", { path: `${base}/main.go` }],
      ["l-read-modcache", "read", { path: `${modcache}/example.com/mod@v1.0.0/mod.go` }],
      ["l-read-ignored", "read", { path: "ignored/hidden.go" }],
      ["l-read-planted-settings", "read", { path: ".pi/settings.json" }],
      ["l-ls", "ls", {}],
      ["l-grep-gitignored", "grep", { pattern: MARKERS.gitignored }],
      ["l-grep-dotignored", "grep", { pattern: MARKERS.dotignored }],
      ["l-grep-rgignored", "grep", { pattern: MARKERS.rgignored }],
      ["l-grep-binary", "grep", { pattern: MARKERS.binary }],
      ["l-grep-outside-via-links", "grep", { pattern: MARKERS.outside }],
      ["l-grep-base", "grep", { pattern: MARKERS.base, path: base }],
      ["l-grep-modcache", "grep", { pattern: MARKERS.modcache, path: modcache }],
      ["l-find-go", "find", { pattern: "*.go" }],
      ["l-find-secret-via-links", "find", { pattern: "secret.go" }],
      ["l-find-modcache", "find", { pattern: "*.go", path: modcache }],
    );
    const forbidden: Call[] = [
      ["f-bash", "bash", { command: "id" }],
      ["f-write", "write", { path: "pwned.txt", content: "x" }],
      ["f-planted", "planted_tool", {}],
    ];

    const faux = fauxProvider();
    const capture = (context: unknown) => {
      contexts.push(structuredClone(context));
    };
    const calls = (list: Call[]) =>
      list.map(([id, name, args]) => fauxToolCall(name, args, { id }));
    faux.setResponses([
      (context) => (capture(context), fauxAssistantMessage(calls(forbidden), { stopReason: "toolUse" })),
      (context) => (capture(context), fauxAssistantMessage(calls(escapes), { stopReason: "toolUse" })),
      (context) => (capture(context), fauxAssistantMessage(calls(legit), { stopReason: "toolUse" })),
      (context) => (capture(context), fauxAssistantMessage(fauxText("DONE"))),
    ]);

    plantedBefore = (globalThis as Record<string, unknown>).__REVIEW_BOT_PLANTED__;
    const step = createPiSdkAgentStep({ providers: [faux.provider], retry: { enabled: false } });
    const model = faux.getModel();
    result = await step.run({
      role: "reviewer",
      model: { provider: model.provider, id: model.id },
      systemPrompt: "You review code.",
      prompt: "Review the change.",
      roots: { head, base, modcache },
      readTools: READ,
      outputTools: [noteTool],
      limits: { timeoutMs: 30_000, maxTurns: 10 },
    });
    for (const r of toolResultsIn(contexts.at(-1))) byId.set(r.toolCallId, r);
  });

  test("the step completes", () => {
    assert.equal(result.outcome, "ok", JSON.stringify(result.error));
    assert.equal(result.usage.turns, 4);
  });

  test("our extension is the only one loaded", () => {
    assert.deepEqual(result.harness.extensions, ["<inline:review-bot>"]);
    assert.ok(!existsSync(layout.plantedRanFile), "a planted extension ran");
    assert.equal((globalThis as Record<string, unknown>).__REVIEW_BOT_PLANTED__, plantedBefore);
  });

  test("the model is offered exactly the allowlist", () => {
    const allow = [...READ, noteTool.name].sort();
    assert.deepEqual([...result.harness.tools].sort(), allow);
    assert.deepEqual(declaredToolsIn(contexts[0]), allow);
  });

  test("no context file, system-prompt file, skill or prompt reaches the model", () => {
    assert.ok(contexts.length === 4);
    contexts.forEach((c, i) => assertNoCanary(JSON.stringify(c), `request ${i + 1}`));
    const first = JSON.stringify(contexts[0]);
    assert.ok(first.includes("You review code."), "our system prompt is missing");
    assert.ok(first.includes(layout.base) && first.includes(layout.modcache), "read roots are not described");
  });

  test("tools that are not on the allowlist cannot run", () => {
    for (const id of ["f-bash", "f-write", "f-planted"]) {
      assert.equal(byId.get(id)?.isError, true, id);
    }
    assert.ok(!existsSync(`${layout.head}/pwned.txt`));
    assert.ok(!existsSync(`${layout.plantedRanFile}.tool`));
    const notAllowed = result.rejectedCalls.filter((r) => r.kind === "not-allowed").map((r) => r.toolCallId);
    assert.deepEqual(notAllowed.sort(), ["f-bash", "f-planted", "f-write"]);
  });

  test("nothing outside the roots is readable", () => {
    for (const [id] of escapes) {
      const seen = byId.get(id);
      assert.ok(seen, `no result for ${id}`);
      assert.equal(seen.isError, true, `${id} was not blocked: ${seen.text}`);
      assert.ok(seen.text.includes(OUTSIDE), `${id}: ${seen.text}`);
    }
    const guarded = result.rejectedCalls.filter((r) => r.kind === "guard").map((r) => r.toolCallId);
    assert.deepEqual(guarded.sort(), escapes.map(([id]) => id).sort());
    // The marker is in some call arguments (grep patterns); check what came back.
    for (const c of contexts) {
      for (const r of toolResultsIn(c)) assert.ok(!r.text.includes(MARKERS.outside), `outside content reached the model: ${r.toolCallId}`);
    }
  });

  test("symlinks are not searched through", () => {
    assert.equal(byId.get("l-grep-outside-via-links")?.text, "No matches found");
    assert.ok(byId.get("l-find-secret-via-links")?.text.startsWith("No files found"));
  });

  test("files inside the roots are readable, including other roots", () => {
    const expect: Record<string, string> = {
      "l-read-head": MARKERS.head,
      "l-read-head-abs": MARKERS.head,
      "l-read-inside-link": MARKERS.head,
      "l-read-base": MARKERS.base,
      "l-read-modcache": MARKERS.modcache,
      "l-read-ignored": MARKERS.gitignored,
      "l-read-planted-settings": "planted_tool",
      "l-grep-base": "main.go",
      "l-grep-modcache": "mod.go",
      "l-find-modcache": "example.com/mod@v1.0.0/mod.go",
    };
    for (const [id, text] of Object.entries(expect)) {
      const seen = byId.get(id);
      assert.equal(seen?.isError, false, `${id}: ${seen?.text}`);
      assert.ok(seen.text.includes(text), `${id}: ${seen.text}`);
    }
    const ls = byId.get("l-ls")!.text.split("\n");
    for (const entry of [".pi/", ".gitignore", "ignored/", "escape-dir", "escape-link", "main.go"]) {
      assert.ok(ls.includes(entry), `ls is missing ${entry}: ${ls.join(",")}`);
    }
  });

  test("ignore files and binary content hide nothing from search", () => {
    assert.ok(byId.get("l-grep-gitignored")!.text.includes("ignored/hidden.go"));
    assert.ok(byId.get("l-grep-dotignored")!.text.includes("dotignored.go"));
    assert.ok(byId.get("l-grep-rgignored")!.text.includes("rgignored.go"));
    assert.ok(byId.get("l-grep-binary")!.text.includes("blob.dat"), byId.get("l-grep-binary")!.text);
    const found = byId.get("l-find-go")!.text.split("\n");
    for (const f of ["main.go", "ignored/hidden.go", "dotignored.go", "rgignored.go"]) {
      assert.ok(found.includes(f), `find is missing ${f}: ${found.join(",")}`);
    }
  });
});
