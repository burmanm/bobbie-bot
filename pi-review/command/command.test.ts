/**
 * The `/review-bot` handler in-process, with a stand-in for pi's API: the
 * interactive defaults and how the exit code is set (F-3, R-1a step 3). The
 * real pi CLI runs it in src/cli/launch.test.ts.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import reviewBotCommand, { COMMAND_NAME } from "./index.ts";
import { quoteCommandArgs } from "../../src/cli/command-args.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "pipeline", "fixtures", "prs", "basic");
const work = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-command-")));
after(() => rmSync(work, { recursive: true, force: true }));
// Beside the runs directories, not around them: an agent directory that
// overlaps a read root is refused (F-7, C-3a).
const agentDir = join(work, "agent");
mkdirSync(agentDir);
const savedExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = savedExitCode;
});

type Handler = (args: string, ctx: unknown) => Promise<void>;

function load() {
  let handler: Handler | undefined;
  let description = "";
  const events = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  const pi = {
    registerCommand: (name: string, options: { description: string; handler: Handler }) => {
      assert.equal(name, COMMAND_NAME);
      description = options.description;
      handler = options.handler;
    },
    on: (event: string, h: (event: unknown, ctx: unknown) => Promise<void>) => void events.set(event, h),
  };
  reviewBotCommand(pi as unknown as ExtensionAPI);
  assert.ok(handler);
  return { handler, description, shutdown: () => events.get("session_shutdown")!({ reason: "quit" }, {}) };
}

function ui(hasUI: boolean) {
  const notes: Array<{ text: string; type: string | undefined }> = [];
  return { notes, ctx: { hasUI, ui: { notify: (text: string, type?: string) => void notes.push({ text, type }) } } };
}

let n = 0;
const args = (extra: string[] = [], script = join(FIXTURE, "script.json")) => {
  const dir = join(work, `run-${++n}`);
  return {
    dir,
    text: quoteCommandArgs(["--fixture", FIXTURE, "--script", script, "--no-modcache", "--runs-dir", join(dir, "runs"), "--out", join(dir, "out.json"), "--agent-dir", agentDir, ...extra]),
  };
};

test("interactive: a dry run without --dry-run, progress shown in pi, the result in --out", async () => {
  const { handler, description } = load();
  assert.match(description, /dry run unless --live/);
  const { notes, ctx } = ui(true);
  const run = args();
  await handler(run.text, ctx);
  assert.equal(process.exitCode, savedExitCode, "interactively the exit code is pi's business");
  assert.equal(JSON.parse(readFileSync(join(run.dir, "out.json"), "utf8")).check_run.conclusion, "success");
  assert.ok(notes.some((note) => /check success/.test(note.text)), JSON.stringify(notes));
  assert.ok(!notes.some((note) => note.type === "error"), JSON.stringify(notes));
});

test("interactive: --live makes it a live run, which a fixture never is", async () => {
  const { handler } = load();
  const { notes, ctx } = ui(true);
  await handler(args(["--live"]).text, ctx);
  assert.ok(notes.some((note) => /--fixture needs --dry-run/.test(note.text)), JSON.stringify(notes));
  assert.ok(notes.some((note) => note.type === "error" && /exit code 2/.test(note.text)));
});

test("print mode: live by default as the CLI, and the exit code is the run's", async () => {
  const { handler } = load();
  await handler(args().text, ui(false).ctx);
  assert.equal(process.exitCode, 2, "a fixture without --dry-run is a usage error, as in the CLI");

  await handler(args(["--dry-run"]).text, ui(false).ctx);
  assert.equal(process.exitCode, 0);

  await handler("--fixture 'unclosed", ui(false).ctx);
  assert.equal(process.exitCode, 2);
});

test("print mode: an exception in the run is exit code 1, never pi's 0", async () => {
  const { handler } = load();
  await handler(args(["--dry-run"], join(work, "no-such-script.json")).text, ui(false).ctx);
  assert.equal(process.exitCode, 1);
});

test("session_shutdown stops a running review and waits for it to publish", async () => {
  const script = JSON.parse(readFileSync(join(FIXTURE, "script.json"), "utf8")) as { reviewer: Array<Record<string, unknown>> };
  script.reviewer[0] = { ...script.reviewer[0], delayMs: 60_000 };
  const file = join(work, "slow-script.json");
  writeFileSync(file, JSON.stringify(script));
  const { handler, shutdown } = load();
  const run = args(["--dry-run"], file);
  const started = Date.now();
  const running = handler(run.text, ui(false).ctx);
  await new Promise((r) => setTimeout(r, 500));
  await shutdown();
  // The shutdown returned only after the run had published.
  assert.equal(JSON.parse(readFileSync(join(run.dir, "out.json"), "utf8")).check_run.conclusion, "neutral");
  await running;
  assert.equal(process.exitCode, 1);
  assert.ok(Date.now() - started < 30_000);
});
