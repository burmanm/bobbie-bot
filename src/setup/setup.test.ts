/**
 * Setup with real npm and git over local fixtures (F-7 question 2, R-1a
 * step 4). Each "no script ran" assertion has a control that runs the same
 * fixture without the protection and does see the marker.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DefaultPackageManager, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { PackageInstallError, SetupConfigError } from "./errors.ts";
import type { CommandRunner } from "./installer.ts";
import { setupPackages } from "./setup.ts";
import {
  commitAll, EXTENSION, gitRepo, layout, markerScripts, marks, offlineRunner, piPackage, plainEnv, sh, tarball, tempDir, write,
} from "./testing.ts";
import { verifyInstalled } from "./verify.ts";

const work = tempDir();
const REPO_URL = "https://example.com/team/pi-git";

/** A package with install scripts and a dependency that has them too. */
function npmFixture() {
  const l = layout(work);
  const inner = tarball(l.root, { name: "fixture-inner", version: "1.0.0", scripts: markerScripts(l.marker, "inner") });
  const outer = tarball(l.root, {
    name: "@fixture/pi-npm",
    version: "1.2.3",
    scripts: markerScripts(l.marker, "outer"),
    dependencies: { "fixture-inner": `file:${inner}` },
  });
  return { ...l, inner, outer, spec: `@fixture/pi-npm@file:${outer}` };
}

/** A repository whose `.npmrc` names programs to run, and a git dependency that does the same. */
function gitFixture() {
  const l = layout(work);
  const evil = join(l.root, "evil");
  write(evil, `#!/bin/sh\necho npmrc:git >> "${l.marker}"\nexec git "$@"\n`, 0o755);
  const required = join(l.root, "evil.cjs");
  write(required, `require("node:fs").appendFileSync(${JSON.stringify(l.marker)}, "npmrc:node-options\\n");\n`);
  const npmrc = `ignore-scripts=false\ngit=${evil}\nnode-options=--require=${required}\n`;

  const leaf = gitRepo(l.root, (dir) => {
    write(join(dir, "package.json"), { name: "fixture-leaf", version: "1.0.0", scripts: markerScripts(l.marker, "leaf") });
  });
  const middle = gitRepo(l.root, (dir) => {
    write(join(dir, "package.json"), {
      name: "fixture-middle",
      version: "1.0.0",
      scripts: markerScripts(l.marker, "middle"),
      dependencies: { "fixture-leaf": `git+file://${leaf.dir}#${leaf.commit}` },
    });
    write(join(dir, ".npmrc"), npmrc);
  });
  const repo = gitRepo(l.root, (dir) => {
    piPackage(dir, {
      name: "fixture-pi-git",
      version: "2.0.0",
      scripts: markerScripts(l.marker, "repo"),
      dependencies: { "fixture-middle": `git+file://${middle.dir}#${middle.commit}` },
    });
    write(join(dir, ".npmrc"), npmrc);
  });
  return { ...l, repo, middle, source: `git:example.com/team/pi-git@${repo.commit}` };
}

/** An agent directory with a package.json, a lockfile and hostile scripts. */
function projectFixture() {
  const f = npmFixture();
  write(join(f.agentDir, "package.json"), {
    name: "operator",
    private: true,
    scripts: markerScripts(f.marker, "project"),
    dependencies: { "@fixture/pi-npm": `file:${f.outer}` },
  });
  sh(f.root, "npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", f.agentDir]);
  write(join(f.agentDir, ".npmrc"), "ignore-scripts=false\n");
  return f;
}

test("control: the npm fixture's scripts run without setup", () => {
  const f = npmFixture();
  const dir = join(f.root, "plain");
  write(join(dir, "package.json"), { name: "plain", private: true });
  sh(f.root, "npm", ["install", f.spec, "--prefix", dir, "--no-audit", "--no-fund"]);
  assert.match(marks(f.marker), /outer:postinstall/);
  assert.match(marks(f.marker), /inner:postinstall/);
});

test("npm: installed at the exact version, and no script ran", async () => {
  const f = npmFixture();
  const { run, calls } = offlineRunner({ "@fixture/pi-npm@1.2.3": f.spec });
  const source = "npm:@fixture/pi-npm@1.2.3";
  const installed = await setupPackages({ agentDir: f.agentDir, forbiddenRoots: f.forbiddenRoots, packages: [{ source, skills: [] }], run });

  assert.deepEqual(installed, [{ name: "@fixture/pi-npm", source, version: "1.2.3" }]);
  assert.equal(marks(f.marker), "");
  assert.ok(existsSync(join(f.agentDir, "npm/node_modules/fixture-inner")), "the dependency is installed");
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.args.includes("--ignore-scripts"));
});

test("npm: a new pin replaces the installed version", async () => {
  const l = layout(work);
  for (const version of ["1.0.0", "2.0.0", "1.0.0"]) {
    const tgz = tarball(l.root, { name: "pi-pin", version });
    const { run } = offlineRunner({ [`pi-pin@${version}`]: `pi-pin@file:${tgz}` });
    const packages = [`npm:pi-pin@${version}`];
    assert.equal((await setupPackages({ agentDir: l.agentDir, forbiddenRoots: l.forbiddenRoots, packages, run }))[0]?.version, version);
  }
});

test("an agent directory given through a link", async () => {
  const f = npmFixture();
  const repo = gitRepo(f.root, (dir) => piPackage(dir, { name: "fixture-pi-git", version: "1.0.0" }));
  const agentDir = join(f.root, "agent-link");
  symlinkSync(f.agentDir, agentDir);
  const { run } = offlineRunner({ "@fixture/pi-npm@1.2.3": f.spec, [REPO_URL]: `file://${repo.dir}` });
  const packages = ["npm:@fixture/pi-npm@1.2.3", `git:example.com/team/pi-git@${repo.commit}`];
  assert.equal((await setupPackages({ agentDir, forbiddenRoots: f.forbiddenRoots, packages, run })).length, 2);
});

test("control: --ignore-scripts alone lets a git dependency's .npmrc run a program", () => {
  const f = gitFixture();
  const dir = join(f.root, "plain");
  write(join(dir, "package.json"), { name: "plain", private: true });
  try {
    sh(f.root, "npm", [
      "install", `fixture-middle@git+file://${f.middle.dir}#${f.middle.commit}`, "--prefix", dir, "--ignore-scripts", "--no-audit", "--no-fund",
    ]);
  } catch {
    // Only the marker matters.
  }
  assert.match(marks(f.marker), /npmrc:git/);
});

test("control: the git fixture's scripts run without setup", () => {
  const f = gitFixture();
  const dir = join(f.root, "plain");
  sh(f.root, "git", ["clone", "--quiet", f.repo.dir, dir]);
  sh(f.root, "npm", ["install", "--prefix", dir, "--no-audit", "--no-fund"]);
  assert.match(marks(f.marker), /repo:postinstall/);
  assert.match(marks(f.marker), /middle:postinstall/);
  assert.match(marks(f.marker), /npmrc:node-options/);
});

test("git: the pinned commit, its dependencies, and nothing from a package ran", async () => {
  const f = gitFixture();
  const { run } = offlineRunner({ [REPO_URL]: `file://${f.repo.dir}` });
  const installed = await setupPackages({ agentDir: f.agentDir, forbiddenRoots: f.forbiddenRoots, packages: [f.source], run });

  assert.deepEqual(installed, [{ name: "fixture-pi-git", source: f.source, version: f.repo.commit }]);
  assert.equal(marks(f.marker), "");
  const target = join(f.agentDir, "git/example.com/team/pi-git");
  assert.ok(existsSync(join(target, "node_modules/fixture-middle")), "the dependency is installed");
  assert.ok(existsSync(join(target, "node_modules/fixture-leaf")), "and its own");
  assert.deepEqual(readdirSync(join(f.agentDir, "git")).sort(), [".gitignore", "example.com"], "no staging directory is left");
});

test("git: an older commit stays pinned, a new pin replaces it", async () => {
  const l = layout(work);
  const repo = gitRepo(l.root, (dir) => piPackage(dir, { name: "fixture-pi-git", version: "1.0.0" }));
  write(join(repo.dir, "index.ts"), `${EXTENSION}// second\n`);
  const second = commitAll(l.root, repo.dir);
  const { run } = offlineRunner({ [REPO_URL]: `file://${repo.dir}` });
  for (const commit of [repo.commit, second, repo.commit]) {
    const packages = [`git:example.com/team/pi-git@${commit}`];
    assert.equal((await setupPackages({ agentDir: l.agentDir, forbiddenRoots: l.forbiddenRoots, packages, run }))[0]?.version, commit);
    const text = readFileSync(join(l.agentDir, "git/example.com/team/pi-git/index.ts"), "utf8");
    assert.equal(text.includes("second"), commit === second);
  }
});

test("git: a failure leaves the installed commit in place", async () => {
  const l = layout(work);
  const repo = gitRepo(l.root, (dir) => piPackage(dir, { name: "fixture-pi-git", version: "1.0.0" }));
  const { run } = offlineRunner({ [REPO_URL]: `file://${repo.dir}` });
  const good = [`git:example.com/team/pi-git@${repo.commit}`];
  const input = { agentDir: l.agentDir, forbiddenRoots: l.forbiddenRoots };
  await setupPackages({ ...input, packages: good, run });
  const missing = [`git:example.com/team/pi-git@${"f".repeat(40)}`];
  await assert.rejects(setupPackages({ ...input, packages: missing, run }), PackageInstallError);
  assert.equal(verifyInstalled({ ...input, packages: good })[0]?.version, repo.commit);
});

test("git: a tag named like a SHA is not a pin", async () => {
  const l = layout(work);
  const repo = gitRepo(l.root, (dir) => piPackage(dir, { name: "fixture-pi-git", version: "1.0.0" }));
  const fake = "e".repeat(64);
  sh(l.root, "git", ["-C", repo.dir, "update-ref", `refs/tags/${fake}`, repo.commit]);
  const { run } = offlineRunner({ [REPO_URL]: `file://${repo.dir}` });
  const packages = [`git:example.com/team/pi-git@${fake}`];
  await assert.rejects(setupPackages({ agentDir: l.agentDir, forbiddenRoots: l.forbiddenRoots, packages, run }), SetupConfigError);
  assert.ok(!existsSync(join(l.agentDir, "git/example.com/team/pi-git")));
});

test("control: the lockfile fixture's scripts run with plain npm ci", () => {
  const f = projectFixture();
  sh(f.root, "npm", ["ci", "--prefix", f.agentDir, "--no-audit", "--no-fund"]);
  assert.match(marks(f.marker), /project:postinstall/);
  assert.match(marks(f.marker), /outer:postinstall/);
});

test("package.json with a lockfile: installed for a local source, and no script ran", async () => {
  const f = projectFixture();
  const { run, calls } = offlineRunner();
  const source = "./node_modules/@fixture/pi-npm";
  const installed = await setupPackages({ agentDir: f.agentDir, forbiddenRoots: f.forbiddenRoots, packages: [source], run });

  assert.deepEqual(installed, [{ name: "@fixture/pi-npm", source, version: "1.2.3" }]);
  assert.equal(marks(f.marker), "");
  assert.deepEqual(calls.map((c) => [c.command, c.args[0]]), [["npm", "ci"]]);
});

test("package.json: no lockfile, or two, is a configuration error before anything runs", async () => {
  for (const locks of [[], ["package-lock.json", "pnpm-lock.yaml"]]) {
    const l = layout(work);
    write(join(l.agentDir, "package.json"), { dependencies: { x: "1.0.0" } });
    for (const name of locks) write(join(l.agentDir, name), "{}");
    const { run, calls } = offlineRunner();
    await assert.rejects(setupPackages({ agentDir: l.agentDir, forbiddenRoots: [], packages: [], run }), SetupConfigError);
    assert.equal(calls.length, 0);
  }
});

test("pnpm: frozen lockfile, no scripts, no pnpmfile (injected runner)", async () => {
  for (const workspace of [false, true]) {
    const l = layout(work);
    write(join(l.agentDir, "package.json"), { dependencies: { "pi-x": "1.2.3" } });
    write(join(l.agentDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      pi-x:\n        specifier: 1.2.3\n        version: 1.2.3(typebox@1.3.27)\n");
    if (workspace) write(join(l.agentDir, "pnpm-workspace.yaml"), "packages: []\n");
    const run: CommandRunner = async (command, args, { env, cwd }) => {
      assert.equal(command, "pnpm");
      for (const flag of ["install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile", "--prod"]) assert.ok(args.includes(flag), flag);
      assert.equal(args.includes("--ignore-workspace"), !workspace);
      assert.equal(env.pnpm_config_ignore_scripts, "true");
      assert.equal(env.npm_config_manage_package_manager_versions, "false");
      assert.ok(!cwd.startsWith(l.agentDir));
      piPackage(join(l.agentDir, "node_modules/pi-x"), { name: "pi-x", version: "1.2.3" });
      return { code: 0, timedOut: false, output: "" };
    };
    const source = "./node_modules/pi-x";
    assert.deepEqual(await setupPackages({ agentDir: l.agentDir, forbiddenRoots: l.forbiddenRoots, packages: [source], run }), [
      { name: "pi-x", source, version: "1.2.3" },
    ]);
  }
});

test("every installer runs from an empty directory outside the roots, without the caller's secrets", async () => {
  const f = projectFixture();
  const seen: string[] = [];
  const run: CommandRunner = async (_command, _args, { cwd, env }) => {
    seen.push(cwd);
    assert.deepEqual(readdirSync(cwd), []);
    for (const root of [f.agentDir, ...f.forbiddenRoots]) assert.ok(!cwd.startsWith(root));
    assert.ok(!JSON.stringify(env).includes("canary-secret"));
    return { code: 0, timedOut: false, output: "" };
  };
  const env = { PATH: process.env.PATH, GH_TOKEN: "canary-secret", OPENROUTER_API_KEY: "canary-secret" };
  // The fake installer installs nothing, so verification fails at the end.
  await assert.rejects(
    setupPackages({ agentDir: f.agentDir, forbiddenRoots: f.forbiddenRoots, packages: ["npm:pi-x@1.0.0"], env, run }),
    SetupConfigError,
  );
  assert.equal(seen.length, 2);
  for (const cwd of seen) assert.ok(!existsSync(cwd), "the working directory is removed");
});

test("a failing or hanging installer is an install error", async () => {
  for (const result of [{ code: 1, timedOut: false, output: "registry said no" }, { code: null, timedOut: true, output: "" }]) {
    const l = layout(work);
    await assert.rejects(
      setupPackages({ agentDir: l.agentDir, forbiddenRoots: [], packages: ["npm:pi-x@1.0.0"], timeoutMs: 1234, run: async () => result }),
      (error: unknown) =>
        error instanceof PackageInstallError && (result.timedOut ? /timed out after 1234 ms/ : /registry said no/).test(error.message),
    );
  }
});

test("an invalid entry or a context file stops setup before any installer", async () => {
  for (const file of [undefined, "AGENTS.md"]) {
    const l = layout(work);
    if (file !== undefined) write(join(l.agentDir, file), "instructions");
    const packages = ["npm:pi-x@1.0.0", ...(file === undefined ? ["npm:pi-y@latest"] : [])];
    const { run, calls } = offlineRunner();
    await assert.rejects(setupPackages({ agentDir: l.agentDir, forbiddenRoots: [], packages, run }), SetupConfigError);
    assert.equal(calls.length, 0);
  }
});

test("setup does not write through a link out of the agent directory", async () => {
  for (const name of ["npm", "git", "node_modules"]) {
    const l = layout(work);
    mkdirSync(join(l.root, "elsewhere"));
    symlinkSync(join(l.root, "elsewhere"), join(l.agentDir, name));
    if (name === "node_modules") {
      write(join(l.agentDir, "package.json"), { dependencies: { x: "1.0.0" } });
      write(join(l.agentDir, "package-lock.json"), {});
    }
    const packages = { npm: ["npm:pi-x@1.0.0"], git: [`git:example.com/team/repo@${"a".repeat(40)}`], node_modules: [] }[name];
    const { run, calls } = offlineRunner();
    await assert.rejects(setupPackages({ agentDir: l.agentDir, forbiddenRoots: [], packages, run }), /outside the agent directory/);
    assert.equal(calls.length, 0);
    assert.deepEqual(readdirSync(join(l.root, "elsewhere")), []);
  }
});

test("offline pi loads exactly what setup installed, without spawning npm (F-7 question 1)", async () => {
  const f = npmFixture();
  const repo = gitRepo(f.root, (dir) => piPackage(dir, { name: "fixture-pi-git", version: "1.0.0" }));
  piPackage(join(f.agentDir, "local"), { name: "fixture-pi-local", version: "0.0.1" });
  const packages = ["npm:@fixture/pi-npm@1.2.3", `git:example.com/team/pi-git@${repo.commit}`, "./local"];
  const { run } = offlineRunner({ "@fixture/pi-npm@1.2.3": f.spec, [REPO_URL]: `file://${repo.dir}` });
  await setupPackages({ agentDir: f.agentDir, forbiddenRoots: f.forbiddenRoots, packages, run });

  const saved = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  try {
    const cwd = join(f.root, "cwd");
    mkdirSync(cwd);
    // An npm that cannot run: any spawn would fail the resolution.
    const settingsManager = SettingsManager.inMemory({ packages, npmCommand: [join(f.root, "no-npm")] }, { projectTrusted: false });
    const loader = new DefaultResourceLoader({
      cwd, agentDir: f.agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    const { extensions, errors } = loader.getExtensions();
    assert.deepEqual(errors, []);
    assert.deepEqual(
      extensions.map((e) => e.path).sort(),
      ["git/example.com/team/pi-git", "local", "npm/node_modules/@fixture/pi-npm"].map((p) => join(f.agentDir, p, "index.ts")),
    );
  } finally {
    if (saved === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = saved;
  }
});

test("pi's own installer does not turn scripts off, which is why setup exists (F-7 question 2)", async () => {
  const l = layout(work);
  const log = join(l.root, "argv.json");
  const recorder = join(l.root, "record.cjs");
  write(recorder, `require("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`);
  const settingsManager = SettingsManager.inMemory({ npmCommand: [process.execPath, recorder] });
  const manager = new DefaultPackageManager({ cwd: l.root, agentDir: l.agentDir, settingsManager });
  await manager.install("npm:pi-x@1.2.3");
  const argv = JSON.parse(readFileSync(log, "utf8")) as string[];
  assert.equal(argv[0], "install");
  assert.ok(!argv.some((arg) => arg.includes("scripts")), argv.join(" "));
});
