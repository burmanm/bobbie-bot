/** The installers' process: environment, stdin, timeout (C-4). */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { inspectAgentDir } from "./agent-dir.ts";
import { installerEnv, runCommand } from "./installer.ts";
import { layout, marks, tempDir, write } from "./testing.ts";

const root = tempDir();

function prepare(from: NodeJS.ProcessEnv) {
  const l = layout(root);
  const work = mkdtempSync(join(l.root, "setup-"));
  return { ...l, work, env: installerEnv(from, work, inspectAgentDir(l.agentDir, l.forbiddenRoots)) };
}

const run = (env: Record<string, string>, cwd: string, command: string, args: string[], timeoutMs = 30_000) =>
  runCommand(command, args, { cwd, env, timeoutMs });

test("no secret reaches an installer, under any name", async () => {
  const secrets = [
    "GITHUB_TOKEN", "GH_TOKEN", "OPENROUTER_API_KEY", "NPM_TOKEN", "NODE_AUTH_TOKEN", "AWS_SECRET_ACCESS_KEY", "ACTIONS_RUNTIME_TOKEN",
    "SSH_AUTH_SOCK", "GIT_CONFIG_PARAMETERS", "GIT_ASKPASS", "NODE_OPTIONS", "npm_config__auth", "PI_CODING_AGENT_DIR", "UNKNOWN_NAME",
  ];
  const from: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: "C", ...Object.fromEntries(secrets.map((n) => [n, "canary-secret"])) };
  from.HTTPS_PROXY = ["http://user", "canary-secret@proxy:8080"].join(":");
  from.http_proxy = "http://proxy:8080";
  const { env, work } = prepare(from);
  const result = await run(env, work, process.execPath, ["-e", "console.log(JSON.stringify(process.env))"]);
  assert.equal(result.code, 0);
  assert.ok(!result.output.includes("canary-secret"), result.output);
  const seen = JSON.parse(result.output) as Record<string, string>;
  for (const name of secrets) assert.equal(seen[name], undefined, name);
  assert.equal(seen.HTTPS_PROXY, undefined);
  assert.equal(seen.http_proxy, "http://proxy:8080");
  assert.equal(seen.LANG, "C");
});

test("PATH has no relative entry and none inside a read root", () => {
  const l = layout(root);
  mkdirSync(join(l.head, "bin"));
  const work = mkdtempSync(join(l.root, "setup-"));
  const from = { PATH: [".", "", "node_modules/.bin", join(l.head, "bin"), "/usr/bin"].join(":") };
  const env = installerEnv(from, work, inspectAgentDir(l.agentDir, l.forbiddenRoots));
  assert.equal(env.PATH, `${dirname(process.execPath)}:/usr/bin`);
});

test("npm ignores the runner's own configuration and a project's program settings", async () => {
  const { root: dir, env, work } = prepare({ PATH: process.env.PATH, HOME: join(root, "runner-home") });
  write(join(root, "runner-home/.npmrc"), "registry=https://registry.canary.invalid/\n");
  write(join(dir, "project/package.json"), { name: "p", private: true });
  write(join(dir, "project/.npmrc"), "ignore-scripts=false\ngit=./evil\nnode-options=--require=./evil.cjs\nscript-shell=./evil\nglobal=true\n");
  const get = async (key: string) =>
    (await run(env, work, "npm", ["config", "get", key, "--prefix", join(dir, "project")])).output.trim();
  assert.equal(await get("registry"), "https://registry.npmjs.org/");
  assert.equal(await get("ignore-scripts"), "true");
  assert.equal(await get("git"), "git");
  assert.equal(await get("node-options"), "--no-warnings");
  assert.equal(await get("script-shell"), "/bin/sh");
});

test("git has no credential helper, no hooks, and reads public GitHub dependencies over https", async () => {
  const { env, work } = prepare({ PATH: process.env.PATH });
  const git = async (...args: string[]) => (await run(env, work, "git", args)).output.trim();
  assert.equal(await git("config", "--get-all", "credential.helper"), "");
  assert.equal(await git("config", "core.hooksPath"), "/dev/null");
  assert.equal(await git("config", "safe.bareRepository"), "explicit");
  for (const url of ["ssh://git@github.com/org/repo.git", "git@github.com:org/repo.git"]) {
    assert.equal(await git("ls-remote", "--get-url", url), "https://github.com/org/repo.git");
  }
});

test("stdin is closed", async () => {
  const { env, work } = prepare({});
  const script = 'process.stdin.on("end", () => console.log("eof")).resume()';
  const result = await run(env, work, process.execPath, ["-e", script], 10_000);
  assert.deepEqual([result.code, result.timedOut, result.output.trim()], [0, false, "eof"]);
});

test("a timeout kills the installer and what it started", async () => {
  const { env, work, marker } = prepare({ PATH: process.env.PATH });
  const started = Date.now();
  const result = await run(env, work, "/bin/sh", ["-c", `(sleep 1; echo survived >> "${marker}") & sleep 30`], 200);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 5_000);
  await sleep(1_300);
  assert.equal(marks(marker), "");
});

test("nothing an installer started outlives it", async () => {
  const { env, work, marker } = prepare({ PATH: process.env.PATH });
  const result = await run(env, work, "/bin/sh", ["-c", `(sleep 1; echo survived >> "${marker}") & exit 0`]);
  assert.deepEqual([result.code, result.timedOut], [0, false]);
  await sleep(1_300);
  assert.equal(marks(marker), "");
});

test("a missing installer is a failed result, not a hang", async () => {
  const { env, work } = prepare({});
  const result = await run(env, work, "review-bot-no-such-installer", []);
  assert.equal(result.code, null);
  assert.match(result.output, /ENOENT/);
});
