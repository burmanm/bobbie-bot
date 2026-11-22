/** Which `packages` entries and agent directories are accepted (F-7, C-3a). */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { REFUSED_FILES } from "./agent-dir.ts";
import { SetupConfigError } from "./errors.ts";
import { validatePackages } from "./sources.ts";
import { layout, tempDir, write } from "./testing.ts";

const work = tempDir();
const SHA = "0123456789abcdef0123456789abcdef01234567";

function refused(input: Parameters<typeof validatePackages>[0], pattern: RegExp): void {
  assert.throws(() => validatePackages(input), (error: unknown) => {
    assert.ok(error instanceof SetupConfigError, String(error));
    assert.match(error.message, pattern);
    return true;
  });
}

test("accepts exact npm versions, string and object form", () => {
  const { agentDir, forbiddenRoots } = layout(work);
  const packages = validatePackages({
    agentDir,
    forbiddenRoots,
    packages: ["npm:pi-x@1.2.3", "npm:@org/pi-y@0.1.0-rc.1", { source: "npm:pi-z@2.0.0", extensions: ["a.ts"], skills: [], autoload: false }],
  });
  assert.deepEqual(
    packages.map((p) => [p.source, p.type === "npm" && p.version, p.path]),
    [
      ["npm:pi-x@1.2.3", "1.2.3", join(agentDir, "npm/node_modules/pi-x")],
      ["npm:@org/pi-y@0.1.0-rc.1", "0.1.0-rc.1", join(agentDir, "npm/node_modules/@org/pi-y")],
      ["npm:pi-z@2.0.0", "2.0.0", join(agentDir, "npm/node_modules/pi-z")],
    ],
  );
});

for (const spec of [
  "pi-x", "@org/pi-x", "pi-x@latest", "pi-x@next", "pi-x@^1.2.3", "pi-x@~1.2.3", "pi-x@1", "pi-x@1.2", "pi-x@1.x", "pi-x@*",
  "pi-x@>=1.0.0", "pi-x@1.2.3 || 2.0.0", "pi-x@1.0.0 - 2.0.0", "pi-x@v1.2.3", "pi-x@=1.2.3", "pi-x@01.2.3", "pi-x@1.2.3+build",
  "pi-x@npm:other@1.2.3", "pi-x@file:../x.tgz", "pi-x@github:org/repo", "pi-x@", "-g@1.2.3", "../x@1.2.3", "x/../../y@1.2.3",
  "node_modules@1.2.3", ".bin@1.2.3", "pi x@1.2.3", " pi-x@1.2.3", "PI-X@1.2.3",
]) {
  test(`refuses npm:${spec}`, () => {
    const { agentDir, forbiddenRoots } = layout(work);
    refused({ agentDir, forbiddenRoots, packages: [`npm:${spec}`] }, /packages\[0\]/);
  });
}

for (const source of [
  `git:github.com/org/repo@${SHA}`,
  `git:https://github.com/org/repo@${SHA}`,
  `git:https://github.com/org/repo.git@${SHA}`,
  `https://github.com/org/repo@${SHA}`,
  `git:gitlab.com/group/sub/repo@${SHA}`,
  `git:example.com/team/repo@${SHA}`,
  `https://example.com:8443/team/repo.git@${SHA}`,
  `git:github.com/org/.github@${SHA}`,
]) {
  test(`accepts ${source}, where pi itself looks for it`, () => {
    const { agentDir, forbiddenRoots } = layout(work);
    const [pkg] = validatePackages({ agentDir, forbiddenRoots, packages: [source] });
    assert.ok(pkg?.type === "git");
    assert.equal(pkg.commit, SHA);
    assert.match(pkg.repo, /^https:\/\//);
    assert.ok(pkg.path.startsWith(join(agentDir, "git/")));
    mkdirSync(pkg.path, { recursive: true });
    const manager = new DefaultPackageManager({ cwd: work, agentDir, settingsManager: SettingsManager.inMemory() });
    assert.equal(manager.getInstalledPath(source, "user"), pkg.path);
  });
}

for (const ref of ["", "@main", "@v1.2.3", "@0123456", `@${SHA.slice(0, 39)}`, `@${SHA}0`, `@${SHA.toUpperCase()}`, "@HEAD", "@refs/heads/main", "#main", `#${SHA}`]) {
  test(`refuses a git source pinned by "${ref}"`, () => {
    const { agentDir, forbiddenRoots } = layout(work);
    refused({ agentDir, forbiddenRoots, packages: [`git:github.com/org/repo${ref}`] }, /full commit SHA/);
  });
}

for (const source of [
  `git:git@github.com:org/repo@${SHA}`,
  `ssh://git@github.com/org/repo@${SHA}`,
  `git:ssh://git@github.com/org/repo@${SHA}`,
  `git://github.com/org/repo@${SHA}`,
  `git:git://github.com/org/repo@${SHA}`,
  `http://github.com/org/repo@${SHA}`,
  `git:github.com/org@${SHA}`,
  `git:github.com/../../etc@${SHA}`,
  `git:github.com/org/repo?x=1@${SHA}`,
  `git:github.com/org/repo#main@${SHA}`,
  "github:org/repo", "file:../pkg", "file:///tmp/pkg", "builtin:mcp", "git+https://github.com/org/repo", "~/pkg",
]) {
  test(`refuses ${source}`, () => {
    const { agentDir, forbiddenRoots } = layout(work);
    refused({ agentDir, forbiddenRoots, packages: [source] }, /packages\[0\]/);
  });
}

test("a credential in a source is refused and not repeated in the error", () => {
  const { agentDir, forbiddenRoots } = layout(work);
  const userinfo = ["someone", "canary-value"].join(":");
  for (const source of [`https://${userinfo}@github.com/org/repo@${SHA}`, `git:${userinfo}@github.com/org/repo@${SHA}`]) {
    assert.throws(
      () => validatePackages({ agentDir, forbiddenRoots, packages: [source] }),
      (error: unknown) => error instanceof SetupConfigError && !error.message.includes("canary-value"),
    );
  }
});

for (const [name, packages] of Object.entries({
  "not an array": {},
  null: null,
  "a number": [1],
  "an empty source": [""],
  "no source": [{ extensions: [] }],
  "an unknown key": [{ source: "./x", extension: [] }],
  "a filter that is no list": [{ source: "./x", skills: "all" }],
  "a control character": ["./x\ny"],
})) {
  test(`refuses packages with ${name}`, () => {
    const { agentDir, forbiddenRoots } = layout(work);
    refused({ agentDir, forbiddenRoots, packages }, /packages/);
  });
}

test("no packages is valid", () => {
  const { agentDir, forbiddenRoots } = layout(work);
  assert.deepEqual(validatePackages({ agentDir, forbiddenRoots, packages: undefined }), []);
});

test("refuses the same package twice and one repository inside another", () => {
  const { agentDir, forbiddenRoots } = layout(work);
  for (const packages of [
    ["npm:pi-x@1.0.0", "npm:pi-x@2.0.0"],
    [`git:github.com/org/repo@${SHA}`, `https://github.com/org/repo.git@${SHA}`],
    [`git:gitlab.com/group/a@${SHA}`, `git:gitlab.com/group/a/b@${SHA}`],
    ["./pkg", "pkg/"],
  ]) {
    refused({ agentDir, forbiddenRoots, packages }, /same package or install over each other/);
  }
});

test("a local path may be anywhere outside the read roots", () => {
  const { root, agentDir, forbiddenRoots } = layout(work);
  mkdirSync(join(root, "shared/pkg"), { recursive: true });
  // `work/head2` only shares a prefix with the root `work/head`.
  mkdirSync(join(root, "work/head2"));
  const packages = ["./pkg", "../shared/pkg", join(root, "work/head2"), "./node_modules/@org/pi-x"];
  assert.equal(validatePackages({ agentDir, forbiddenRoots, packages }).length, 4);
});

test("a local path into a read root is refused", () => {
  const { root, agentDir, head, forbiddenRoots } = layout(work);
  mkdirSync(join(head, "evil/nested"), { recursive: true });
  mkdirSync(join(agentDir, "inner"));
  symlinkSync(join(head, "evil"), join(agentDir, "inner/link"));
  symlinkSync("../../work/head/not-yet", join(agentDir, "inner/dangling"));
  symlinkSync(agentDir, join(root, "alias"));
  for (const source of [
    "../work/head", "../work/head/evil", "../work/head/missing", head, `${agentDir}/../work/base`,
    // A directory holding a root would have the snapshot inside the package.
    "../work",
    "./inner/link", "./inner/link/nested", "./inner/dangling", join(root, "alias/inner/link"),
  ]) {
    refused({ agentDir, forbiddenRoots, packages: [source] }, /overlaps the read root/);
  }
});

test("`..` after a link applies to where the link led", () => {
  const { agentDir, head, forbiddenRoots } = layout(work);
  mkdirSync(join(head, "a"), { recursive: true });
  mkdirSync(join(agentDir, "inner"));
  symlinkSync(join(head, "a"), join(agentDir, "inner/jump"));
  symlinkSync("jump/../missing", join(agentDir, "inner/via"));
  refused({ agentDir, forbiddenRoots, packages: ["./inner/via"] }, /overlaps the read root/);
});

test("roots need not exist yet, and may be given through a link", () => {
  const { root, agentDir } = layout(work);
  const snapshot = join(root, "later");
  refused({ agentDir, forbiddenRoots: [join(snapshot, "head")], packages: ["../later/head/pkg"] }, /overlaps/);
  symlinkSync(join(root, "work"), join(root, "work-link"));
  refused({ agentDir, forbiddenRoots: [join(root, "work-link/head")], packages: ["../work/head/pkg"] }, /overlaps/);
});

test("the agent directory cannot be in, contain or link into a read root", () => {
  const a = layout(work);
  refused({ agentDir: a.agentDir, forbiddenRoots: [a.agentDir], packages: [] }, /overlaps/);
  refused({ agentDir: join(a.head, "agent"), forbiddenRoots: a.forbiddenRoots, packages: [] }, /overlaps/);
  refused({ agentDir: a.root, forbiddenRoots: a.forbiddenRoots, packages: [] }, /overlaps/);
  for (const name of ["settings.json", "models.json", ".npmrc", "package.json", "npm", "git", "node_modules"]) {
    const b = layout(work);
    symlinkSync(join(b.head, name), join(b.agentDir, name));
    refused({ agentDir: b.agentDir, forbiddenRoots: b.forbiddenRoots, packages: [] }, /overlaps the read root/);
  }
});

test("relative directories are refused: the working directory is not the snapshot's to choose", () => {
  const { agentDir } = layout(work);
  refused({ agentDir: "agent", forbiddenRoots: [], packages: [] }, /absolute/);
  refused({ agentDir, forbiddenRoots: ["head"], packages: [] }, /absolute/);
});

for (const name of [...REFUSED_FILES, "agents.md", "system.MD"]) {
  test(`refuses an agent directory with ${name}`, () => {
    const { agentDir, forbiddenRoots } = layout(work);
    write(join(agentDir, name), "instructions");
    refused({ agentDir, forbiddenRoots, packages: [] }, /must not contain/);
  });
}

test("the refused names are every one pi recognises (F-6: check on upgrade)", () => {
  const dist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const loader = readFileSync(join(dist, "core/resource-loader.js"), "utf8");
  const candidates = /function loadContextFileFromDir\(dir\) \{\s*const candidates = (\[[^\]]*\]);/.exec(loader)?.[1];
  assert.ok(candidates, "pi's context-file candidates moved");
  const prompts = [...loader.matchAll(/join\(this\.agentDir, "([^"]+\.md)"\)/gi)].map((m) => m[1]);
  assert.deepEqual([...new Set([...(JSON.parse(candidates) as string[]), ...prompts])].sort(), [...REFUSED_FILES].sort());
});
