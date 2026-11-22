/**
 * The mandatory isolation regression test (C-3a, D-15). Runs on every pi
 * upgrade (F-6).
 *
 * A snapshot plants hostile `.pi/` settings, an extension, skills, prompts
 * and system-prompt files, `AGENTS.md`/`CLAUDE.md` in the snapshot and its
 * parents, escaping symlinks and ignore files that hide code; the user-level
 * pi directory and home directory are hostile too. A real SDK step runs
 * against pi's scripted model, which records exactly what it was sent.
 *
 * The snapshot also holds what would take over a module, or git, working in
 * it: a config with a command and embedded bare repositories (D-19). The
 * controls show that each fires when its protection is missing.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { unpackTarGz } from "../ci/tar.ts";
import { createPiSdkAgentStep } from "./pi-sdk-step.ts";
import {
  buildHostileSnapshot,
  CANARIES,
  declaredToolsIn,
  type HostileLayout,
  MARKERS,
  type ModuleSaw,
  NESTED_REPO,
  noteTool,
  type PayloadMarkers,
  PLAIN_GIT_ENV,
  plantCwdPayloads,
  type SeenToolResult,
  setEnv,
  toolResultsIn,
  withTestExtension,
  workingDirectoryModule,
} from "./testing.ts";
import type { AgentStepResult, ReadToolName } from "./types.ts";

const READ: ReadToolName[] = ["read", "grep", "find", "ls"];
const OUTSIDE = "outside the allowed read roots";

let layout: HostileLayout;
let restoreGitEnv: () => void;
const savedEnv = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };

before(() => {
  restoreGitEnv = setEnv(PLAIN_GIT_ENV);
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
  restoreGitEnv();
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

describe("control: the working-directory payloads are hostile (D-19)", () => {
  const BARE_EXPLICIT = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.bareRepository", GIT_CONFIG_VALUE_0: "explicit" };

  let scratch: string;
  let tree: string;
  let ran: PayloadMarkers;
  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-payload-")));
    tree = join(scratch, "tree");
    ran = plantCwdPayloads(tree, scratch);
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  const fired = () => ({
    toolConfig: existsSync(ran.toolConfig),
    rootRepo: existsSync(ran.rootRepo),
    nestedRepo: existsSync(ran.nestedRepo),
  });

  /** The module in a session with every other C-3a option on: only cwd and git's environment vary. */
  async function runModule(cwd: string, snapshot: string, gitEnv: Record<string, string> = {}): Promise<void> {
    const restore = setEnv({ ...PLAIN_GIT_ENV, ...gitEnv });
    try {
      const agentDir = join(scratch, "agent");
      const faux = fauxProvider();
      const modelRuntime = await ModelRuntime.create({ modelsPath: null, authPath: join(agentDir, "auth.json") });
      modelRuntime.registerNativeProvider(faux.provider);
      const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        extensionFactories: [{ name: "module", factory: workingDirectoryModule(join(snapshot, NESTED_REPO)).factory }],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: "control",
      });
      await resourceLoader.reload();
      const { session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime,
        model: faux.getModel(),
        tools: [],
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager,
        resourceLoader,
      });
      try {
        await session.bindExtensions({ mode: "json" });
      } finally {
        session.dispose();
      }
    } finally {
      restore();
    }
  }

  test("old behaviour, cwd = head: the config's command and both repositories' commands run", async () => {
    await runModule(tree, tree);
    assert.deepEqual(fired(), { toolConfig: true, rootRepo: true, nestedRepo: true });
  });

  test("safe.bareRepository alone leaves the cwd config", async () => {
    await runModule(tree, tree, BARE_EXPLICIT);
    assert.deepEqual(fired(), { toolConfig: true, rootRepo: false, nestedRepo: false });
  });

  test("a neutral cwd alone leaves git that is run inside the snapshot", async () => {
    const neutral = join(scratch, "neutral");
    mkdirSync(neutral);
    await runModule(neutral, tree);
    assert.deepEqual(fired(), { toolConfig: false, rootRepo: false, nestedRepo: true });
  });

  test("the payloads survive git archive and our extractor, still hostile", async () => {
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", tree, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "--quiet");
    git("add", "--all");
    const archive = join(scratch, "tree.tar.gz");
    // A tree is enough: no commit is needed to archive it.
    git("archive", "--format=tar.gz", `--output=${archive}`, git("write-tree"));
    const extracted = join(scratch, "extracted");
    mkdirSync(extracted);
    await unpackTarGz(archive, extracted);
    await runModule(extracted, extracted);
    assert.deepEqual(fired(), { toolConfig: true, rootRepo: true, nestedRepo: true });
  });
});

describe("isolated step on the hostile snapshot", () => {
  const contexts: unknown[] = [];
  let result: AgentStepResult<typeof noteTool>;
  const byId = new Map<string, SeenToolResult>();

  type Call = [id: string, tool: string, args: Record<string, string>];
  const escapes: Call[] = [];
  const legit: Call[] = [];
  let saw: ModuleSaw;
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
      ["e-find-dotdot", "find", { pattern: "*", path: "ignored/../.." }],
      ["e-ls-dotdot", "ls", { path: ".." }],
    );
    legit.push(
      ["l-read-head", "read", { path: "main.go" }],
      ["l-read-head-abs", "read", { path: `${head}/main.go` }],
      ["l-read-dot", "read", { path: "./ignored/../main.go" }],
      ["l-read-at", "read", { path: "@main.go" }],
      ["l-read-base-relative", "read", { path: "../base/main.go" }],
      ["l-ls-sub", "ls", { path: "ignored" }],
      ["l-grep-sub", "grep", { pattern: MARKERS.gitignored, path: "ignored" }],
      ["l-grep-file", "grep", { pattern: MARKERS.head, path: "main.go" }],
      ["l-find-sub", "find", { pattern: "*.go", path: "ignored" }],
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
      (context) => {
        capture(context);
        // Known only now: the step's own directory is not a read root either.
        escapes.push(["e-cwd", "ls", { path: saw.cwds.get("ctx.cwd")! }]);
        return fauxAssistantMessage(calls(escapes), { stopReason: "toolUse" });
      },
      (context) => (capture(context), fauxAssistantMessage(calls(legit), { stopReason: "toolUse" })),
      (context) => (capture(context), fauxAssistantMessage(fauxText("DONE"))),
    ]);

    plantedBefore = (globalThis as Record<string, unknown>).__REVIEW_BOT_PLANTED__;
    const step = createPiSdkAgentStep({ providers: [faux.provider], retry: { enabled: false } });
    const model = faux.getModel();
    const module = workingDirectoryModule(join(head, NESTED_REPO));
    saw = module.saw;
    result = await withTestExtension(module.factory, () => step.run({
      role: "reviewer",
      model: { provider: model.provider, id: model.id },
      systemPrompt: "You review code.",
      prompt: "Review the change.",
      roots: { head, base, modcache },
      readTools: READ,
      outputTools: [noteTool],
      limits: { timeoutMs: 30_000, maxTurns: 10 },
    }));
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

  test("the cwd is the step's own empty directory, outside every read root, everywhere pi gives it out", () => {
    const sources = ["ctx.cwd", "pi.exec", "resources_discover", "sessionManager", "systemPromptOptions", "tool_call"];
    assert.deepEqual([...saw.cwds.keys()].sort(), sources);
    assert.equal(new Set(saw.cwds.values()).size, 1, JSON.stringify([...saw.cwds]));
    const cwd = saw.cwds.get("ctx.cwd")!;
    for (const root of [layout.head, layout.base, layout.modcache]) {
      assert.ok(!`${cwd}/`.startsWith(`${root}/`) && !`${root}/`.startsWith(`${cwd}/`), `${cwd} overlaps ${root}`);
    }
    assert.deepEqual(saw.entries, []);
    for (let dir = cwd; dir !== dirname(dir); dir = dirname(dir)) {
      for (const name of [".git", "AGENTS.md", "AGENTS.override.md", "CLAUDE.md"]) {
        assert.ok(!existsSync(join(dir, name)), `${join(dir, name)} is above the cwd`);
      }
    }
    assert.ok(!existsSync(cwd), "the cwd was not removed");
  });

  test("a module's cwd config does not take effect", () => {
    assert.ok(saw.entries !== undefined, "the module did not run");
    assert.ok(existsSync(join(layout.head, ".tool.json")), "the payload is not planted");
    assert.ok(!existsSync(layout.payloadRan.toolConfig), "the PR's .tool.json command ran");
  });

  test("an embedded bare repository does not take effect, also when git runs inside it", () => {
    assert.deepEqual(saw.git.map((g) => g.where), ["cwd", "visited"], "the module did not run git");
    const [inCwd, visited] = saw.git;
    assert.match(inCwd!.stderr, /not a git repository/);
    assert.notEqual(visited!.status, 0);
    assert.match(visited!.stderr, /safe\.bareRepository is 'explicit'/);
    assert.ok(!existsSync(layout.payloadRan.rootRepo), "the root repository's command ran");
    assert.ok(!existsSync(layout.payloadRan.nestedRepo), "the nested repository's command ran");
  });

  test("the model is shown head as the place relative paths resolve, never the cwd", () => {
    const cwd = saw.cwds.get("ctx.cwd")!;
    // The last request has the escapes in it, one of which is the cwd.
    for (const c of contexts.slice(0, 2)) assert.ok(!JSON.stringify(c).includes(cwd), "the cwd was shown to the model");
    const first = JSON.stringify(contexts[0]);
    assert.ok(first.includes(`<cwd>\\n${layout.head} (head:`), "the cwd section does not name head");
    assert.ok(first.includes(`head: ${layout.head} (relative paths, and omitted ones, resolve here)`));
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
      "l-read-dot": MARKERS.head,
      "l-read-at": MARKERS.head,
      "l-read-base-relative": MARKERS.base,
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

  test("relative paths resolve in head and results are relative to what was searched", () => {
    assert.equal(byId.get("l-ls-sub")?.text, "hidden.go");
    assert.equal(byId.get("l-find-sub")?.text, "hidden.go");
    assert.match(byId.get("l-grep-sub")!.text, /^hidden\.go:1: /);
    assert.match(byId.get("l-grep-file")!.text, /^main\.go:3: /);
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
