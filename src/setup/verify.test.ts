/** The offline check: files only, no network, no process (C-3a, F-7). */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { SetupConfigError } from "./errors.ts";
import { layout, piPackage, tempDir, write } from "./testing.ts";
import { verifyInstalled } from "./verify.ts";

const work = tempDir();
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const NPM = "npm:pi-x@1.2.3";
const GIT = `git:example.com/team/repo@${COMMIT}`;

const SPAWNERS = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;
const mutable = childProcess as unknown as Record<string, unknown>;
const original = Object.fromEntries(SPAWNERS.map((name) => [name, mutable[name]]));
const originalFetch = globalThis.fetch;
let escapes: string[] = [];

// Verification may start no process and make no request, in any test here.
beforeEach(() => {
  escapes = [];
  for (const name of SPAWNERS) {
    mutable[name] = () => {
      escapes.push(name);
      throw new Error(`verification called ${name}`);
    };
  }
  syncBuiltinESMExports();
  globalThis.fetch = async () => {
    escapes.push("fetch");
    throw new Error("verification called fetch");
  };
});
afterEach(() => assert.deepEqual(escapes, []));
after(() => {
  Object.assign(mutable, original);
  syncBuiltinESMExports();
  globalThis.fetch = originalFetch;
});

function installed() {
  const l = layout(work);
  const npm = join(l.agentDir, "npm/node_modules/pi-x");
  piPackage(npm, { name: "pi-x", version: "1.2.3" });
  const git = join(l.agentDir, "git/example.com/team/repo");
  piPackage(git, { name: "pi-git", version: "9.9.9" });
  write(join(git, ".git/HEAD"), `${COMMIT}\n`);
  piPackage(join(l.agentDir, "local"), { name: "pi-local", version: "0.1.0" });
  write(join(l.agentDir, "single.ts"), "export default function () {}\n");
  const input = { agentDir: l.agentDir, forbiddenRoots: l.forbiddenRoots, packages: [NPM, GIT, "./local", "./single.ts"] as unknown };
  return { ...l, npm, git, input };
}

function fails(input: Parameters<typeof verifyInstalled>[0], pattern: RegExp): void {
  assert.throws(() => verifyInstalled(input), (error: unknown) => {
    assert.ok(error instanceof SetupConfigError, String(error));
    assert.match(error.message, pattern);
    return true;
  });
}

test("returns name, source and resolved version, in the configured order", () => {
  assert.deepEqual(verifyInstalled(installed().input), [
    { name: "pi-x", source: NPM, version: "1.2.3" },
    { name: "pi-git", source: GIT, version: COMMIT },
    { name: "pi-local", source: "./local", version: "0.1.0" },
    { name: "single.ts", source: "./single.ts" },
  ]);
});

for (const path of ["npm", "git", "local", "single.ts"]) {
  test(`a missing package is a configuration error, which pi would skip: ${path}`, () => {
    const { agentDir, input } = installed();
    rmSync(join(agentDir, path), { recursive: true });
    fails(input, /not installed/);
  });
}

test("another npm version or name is an error", () => {
  for (const manifest of [{ name: "pi-x", version: "1.2.4" }, { name: "pi-other", version: "1.2.3" }, { name: "pi-x" }]) {
    const { npm, input } = installed();
    write(join(npm, "package.json"), manifest);
    fails(input, /is pinned/);
  }
});

test("an npm package without or with a broken package.json is an error", () => {
  const a = installed();
  rmSync(join(a.npm, "package.json"));
  fails(a.input, /is pinned/);
  const b = installed();
  write(join(b.npm, "package.json"), "{");
  fails(b.input, /not valid JSON/);
});

test("another commit, a branch or no checkout is an error", () => {
  for (const head of [`${"f".repeat(40)}\n`, "ref: refs/heads/main\n", undefined]) {
    const { git, input } = installed();
    if (head === undefined) rmSync(join(git, ".git"), { recursive: true });
    else write(join(git, ".git/HEAD"), head);
    fails(input, /the pin is/);
  }
});

test("an unfinished git install is an error", () => {
  const a = installed();
  write(join(a.agentDir, "git/example.com/team/.repo.pi-update-incomplete"), "");
  fails(a.input, /unfinished update/);
  const b = installed();
  write(join(b.git, "package.json"), { name: "pi-git", dependencies: { dep: "1.0.0" } });
  fails(b.input, /dependencies are not installed/);
});

test("an installed copy that links into a read root is an error", () => {
  const { npm, head, input } = installed();
  rmSync(npm, { recursive: true });
  mkdirSync(join(head, "pi-x"));
  symlinkSync(join(head, "pi-x"), npm);
  fails(input, /overlaps the read root/);
});

test("a context file added after setup is refused in the review step too", () => {
  const { agentDir, input } = installed();
  write(join(agentDir, "APPEND_SYSTEM.md"), "instructions");
  fails(input, /must not contain/);
});

const LOCKS: Record<string, [string, string | object]> = {
  npm: ["package-lock.json", { lockfileVersion: 3, packages: { "node_modules/@org/pi-y": { version: "2.0.0" } } }],
  "pnpm v9": ["pnpm-lock.yaml", "importers:\n  .:\n    dependencies:\n      '@org/pi-y':\n        specifier: 2.0.0\n        version: 2.0.0(peer@1.0.0)\n"],
  "pnpm v6": ["pnpm-lock.yaml", "dependencies:\n  '@org/pi-y':\n    specifier: 2.0.0\n    version: 2.0.0\n"],
  "pnpm alias": ["pnpm-lock.yaml", "importers:\n  .:\n    dependencies:\n      '@org/pi-y':\n        specifier: npm:@org/real@2.0.0\n        version: '@org/real@2.0.0'\n"],
};

for (const [name, [file, lock]] of Object.entries(LOCKS)) {
  test(`a node_modules source is held to the lockfile: ${name}`, () => {
    const { agentDir, forbiddenRoots } = layout(work);
    write(join(agentDir, "package.json"), { dependencies: { "@org/pi-y": "2.0.0" } });
    write(join(agentDir, file), lock);
    const dir = join(agentDir, "node_modules/@org/pi-y");
    const input = { agentDir, forbiddenRoots, packages: ["./node_modules/@org/pi-y"] };
    piPackage(dir, { name: "@org/pi-y", version: "2.0.0" });
    assert.equal(verifyInstalled(input)[0]?.version, "2.0.0");
    write(join(dir, "package.json"), { name: "@org/pi-y", version: "1.9.0" });
    fails(input, /the lockfile pins 2\.0\.0/);
  });
}

test("a node_modules source without a lockfile entry is not pinned", () => {
  const { agentDir, forbiddenRoots } = layout(work);
  piPackage(join(agentDir, "node_modules/pi-y"), { name: "pi-y", version: "1.0.0" });
  fails({ agentDir, forbiddenRoots, packages: ["./node_modules/pi-y"] }, /not pinned by a lockfile/);
});
