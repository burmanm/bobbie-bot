/**
 * The gate's side of the agent directory (F-7, R-1a step 2b): fetched from
 * the default branch or a pinned commit, never the PR; its settings layered
 * under the workflow inputs; read without loading pi.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { runCi } from "../cli/ci.ts";
import { PI_PINNED_VERSION } from "../core/index.ts";
import { NO_AGENT_SETTINGS, parseAgentSettings } from "../pipeline/agent-settings.ts";
import { fetchAgentDir, validAgentDirPath } from "./agent-dir.ts";
import { DEFAULT_CI_WAIT } from "./ci-wait.ts";
import { layerGateInputs, resolveGateConfig } from "./gate.ts";
import { Github } from "./github.ts";
import { fakeGithub, type FakeRepo, SHA_A, SHA_B } from "./testing.ts";

const work = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-agentdir-")));
after(() => rmSync(work, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(work, `d${n++}`);

const DEFAULT_HEAD = "d".repeat(40);
const PINNED = "e".repeat(40);

function repo(over: Partial<FakeRepo> = {}): FakeRepo {
  return {
    pulls: {},
    roles: {},
    defaultBranch: { name: "main", sha: DEFAULT_HEAD },
    trees: {
      [DEFAULT_HEAD]: [
        { path: "README.md", mode: "100644", type: "blob", sha: "b0" },
        { path: ".github", mode: "040000", type: "tree", sha: "t0" },
        { path: ".github/review-bot", mode: "040000", type: "tree", sha: "t1" },
        { path: ".github/review-bot/settings.json", mode: "100644", type: "blob", sha: "b1", size: 40 },
        { path: ".github/review-bot/models.json", mode: "100644", type: "blob", sha: "b2", size: 16 },
        { path: ".github/review-bot/sub", mode: "040000", type: "tree", sha: "t2" },
        { path: ".github/review-bot/sub/notes.txt", mode: "100644", type: "blob", sha: "b3", size: 2 },
        { path: ".github/review-bot-other/settings.json", mode: "100644", type: "blob", sha: "b9", size: 2 },
      ],
      [PINNED]: [{ path: "agent/settings.json", mode: "100644", type: "blob", sha: "b4", size: 2 }],
    },
    blobs: {
      b1: JSON.stringify({ reviewBot: { authorization: { label: "from-settings" } } }),
      b2: '{"providers":{}}',
      b3: "hi",
      b4: "{}",
      b9: "{}",
    },
    ...over,
  };
}
const gh = (r: FakeRepo, name = "o/r") => {
  const f = fakeGithub(r);
  return { gh: new Github({ token: "t", repo: name, fetch: f.fetch }), calls: f.calls };
};

describe("fetch-agent-dir (F-7, D-19)", () => {
  test("from the default branch's head: only that directory, read-only files", async () => {
    const dest = fresh();
    const got = await fetchAgentDir(gh(repo()).gh, { path: ".github/review-bot", dest });
    assert.deepEqual(got, { repo: "o/r", sha: DEFAULT_HEAD, branch: "main", files: 3, bytes: got.bytes });
    assert.deepEqual(readdirSync(dest).sort(), ["models.json", "settings.json", "sub"]);
    assert.equal(readFileSync(join(dest, "sub", "notes.txt"), "utf8"), "hi");
    assert.equal(statSync(join(dest, "settings.json")).mode & 0o222, 0, "not writable");
  });

  test("from a pinned commit: the default branch is never consulted", async () => {
    const { gh: client, calls } = gh(repo(), "org/config");
    const got = await fetchAgentDir(client, { path: "agent", ref: PINNED, dest: fresh() });
    assert.equal(got.sha, PINNED);
    assert.ok(!calls.some((c) => c.path === "" || c.path.startsWith("/commits/")));
  });

  test("symlinks, submodules, unsafe paths, a missing directory and a non-empty destination are refused", async () => {
    const r = repo();
    r.trees![DEFAULT_HEAD]!.push({ path: ".github/review-bot/link", mode: "120000", type: "blob", sha: "b5" });
    await assert.rejects(fetchAgentDir(gh(r).gh, { path: ".github/review-bot", dest: fresh() }), /only regular files.*link \(120000\)/);
    const s = repo();
    s.trees![DEFAULT_HEAD]!.push({ path: ".github/review-bot/mod", mode: "160000", type: "commit", sha: "c1" });
    await assert.rejects(fetchAgentDir(gh(s).gh, { path: ".github/review-bot", dest: fresh() }), /only regular files/);
    for (const bad of ["", "/abs", "a/../b", "..", "a//b", "a/", "./a", "a b", "a\\b"]) {
      assert.equal(validAgentDirPath(bad), false, bad);
      await assert.rejects(fetchAgentDir(gh(repo()).gh, { path: bad, dest: fresh() }), /invalid agent directory path/, bad);
    }
    assert.ok(validAgentDirPath(".github/review-bot"));
    await assert.rejects(fetchAgentDir(gh(repo()).gh, { path: "nope", dest: fresh() }), /no such directory/);
    await assert.rejects(fetchAgentDir(gh(repo()).gh, { path: "agent", ref: "main", dest: fresh() }), /pinned to a 40-hex commit SHA/);
    const full = fresh();
    mkdirSync(full);
    writeFileSync(join(full, "x"), "");
    await assert.rejects(fetchAgentDir(gh(repo()).gh, { path: ".github/review-bot", dest: full }), /not empty/);
  });

  test("the CLI command", async () => {
    const dest = join(fresh(), "dir");
    const err: string[] = [];
    const io = { stdout: () => {}, stderr: (s: string) => void err.push(s) };
    const f = fakeGithub(repo());
    const code = await runCi("fetch-agent-dir", ["--path", ".github/review-bot", "--dest", dest], io, { env: { GH_TOKEN: "t", GITHUB_REPOSITORY: "o/r" }, fetch: f.fetch });
    assert.equal(code, 0, err.join(""));
    assert.ok(existsSync(join(dest, "settings.json")));
    assert.match(err.join(""), new RegExp(`from o/r@${DEFAULT_HEAD} \\(default branch main\\): 3 files`));
    assert.equal(await runCi("fetch-agent-dir", ["--path", "agent", "--ref", "main", "--dest", fresh()], io, { env: { GH_TOKEN: "t", GITHUB_REPOSITORY: "o/r" } }), 2);
  });
});

describe("gate configuration: defaults, settings, inputs, then the YAML (F-7)", () => {
  const settings = parseAgentSettings(
    JSON.stringify({ reviewBot: { authorization: { label: "s-label", lifetime: "per-pr" }, ci: { require: ["build"], onFailure: "review", timeout: "2h" } } }),
  );

  test("unset everywhere: the built-in defaults", () => {
    assert.deepEqual(layerGateInputs({ name: "main" }, undefined), { name: "main", label: "ai-review/approved", lifetime: "per-push", ci: DEFAULT_CI_WAIT });
    assert.deepEqual(layerGateInputs({ name: "main" }, NO_AGENT_SETTINGS), layerGateInputs({ name: "main" }, undefined));
  });

  test("settings show through inputs that were not given", () => {
    assert.deepEqual(layerGateInputs({ name: "main" }, settings), {
      name: "main",
      label: "s-label",
      lifetime: "per-pr",
      ci: { require: ["build"], onFailure: "review", timeoutMs: 7_200_000 },
    });
  });

  test("given inputs override settings, field by field", () => {
    const c = layerGateInputs({ name: "main", label: "i-label", ci: { onFailure: "skip" } }, settings);
    assert.deepEqual([c.label, c.lifetime, c.ci.require, c.ci.onFailure], ["i-label", "per-pr", ["build"], "skip"]);
  });

  test("the base branch's YAML stays on top, as the repository's own policy", () => {
    const layered = layerGateInputs({ name: "main" }, settings);
    const c = resolveGateConfig(layered, "authorization: { label: y-label }\nci: { require: off }\n", () => {});
    assert.deepEqual([c.label, c.lifetime, c.ci.require], ["y-label", "per-pr", "off"]);
    const warned: string[] = [];
    assert.equal(resolveGateConfig(layered, "nonsense: 1", (l) => warned.push(l)).lifetime, "per-push", "invalid YAML: the stricter lifetime");
  });

  test("CLI: --agent-dir supplies the label when --label is not given; empty flags count as not given", async () => {
    const dir = fresh();
    mkdirSync(dir);
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ reviewBot: { authorization: { label: "from-settings" } } }));
    const eventPath = join(dir, "..", `event-${n++}.json`);
    writeFileSync(eventPath, JSON.stringify({ action: "opened", number: 7, pull_request: { number: 7, head: { sha: SHA_A } }, sender: { login: "maint" } }));
    const out = join(dir, "..", `out-${n++}`);
    writeFileSync(out, "");
    const r: FakeRepo = {
      pulls: { 7: { number: 7, user: { login: "maint" }, labels: [], head: SHA_A, base: SHA_B } },
      roles: { maint: "write" },
      files: { [`.review/review-bot.yaml@${SHA_B}`]: "" },
    };
    const err: string[] = [];
    const io = { stdout: () => {}, stderr: (s: string) => void err.push(s) };
    const env = { GH_TOKEN: "t", GITHUB_REPOSITORY: "o/r", GITHUB_EVENT_NAME: "pull_request_target", GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: out };
    const code = await runCi("gate", ["--agent-dir", dir, "--label", "", "--lifetime", ""], io, { env, fetch: fakeGithub(r).fetch });
    assert.equal(code, 0, err.join(""));
    assert.match(readFileSync(out, "utf8"), /^label=from-settings$/m);
    writeFileSync(out, "");
    assert.equal(await runCi("gate", ["--agent-dir", dir, "--label", "given"], io, { env, fetch: fakeGithub(r).fetch }), 0);
    assert.match(readFileSync(out, "utf8"), /^label=given$/m);
    // A broken settings.json fails the gate; the workflow then completes the check (S-9).
    writeFileSync(join(dir, "settings.json"), "{");
    assert.equal(await runCi("gate", ["--agent-dir", dir], io, { env, fetch: fakeGithub(r).fetch }), 1);
    assert.match(err.join(""), /agent directory: .*settings\.json is not valid JSON/);
  });
});

describe("the gate and the CI commands do not load pi (F-7)", () => {
  const url = (file: string) => JSON.stringify(new URL(file, import.meta.url).href);
  const noPi = (body: string) => {
    const program = `
      import { registerHooks } from "node:module";
      registerHooks({ resolve(specifier, context, next) {
        if (specifier.startsWith("@earendil-works/")) throw new Error("pi was loaded: " + specifier);
        return next(specifier, context);
      } });
      ${body}
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };

  test("gate.ts, ci.ts and the CLI entry point import without pi", () => {
    noPi(`
      const { layerGateInputs } = await import(${url("./gate.ts")});
      const { parseAgentSettings } = await import(${url("../pipeline/agent-settings.ts")});
      layerGateInputs({ name: "main" }, parseAgentSettings('{"reviewBot":{"ci":{"require":"required"}}}'));
      await import(${url("../cli/ci.ts")});
      const { main } = await import(${url("../cli/main.ts")});
      const out = [];
      await main(["--help"], { stdout: (t) => out.push(t), stderr: (t) => out.push(t) });
      if (!out.join("").includes("--agent-dir")) throw new Error("no help");
    `);
  });

  test("the pi version in gate records is pi's own (F-6)", async () => {
    const { VERSION } = await import("@earendil-works/pi-coding-agent");
    assert.equal(PI_PINNED_VERSION, VERSION);
  });
});
