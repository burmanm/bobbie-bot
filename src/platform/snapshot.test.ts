/** `GitArchiveSnapshots` with git's `safe.bareRepository=explicit` set, as every entry point now does (C-3a, R-1a step 3). */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { requireExplicitBareRepository } from "../core/git-env.ts";
import { GitArchiveSnapshots } from "./snapshot.ts";

const work = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-snapshot-")));
const saved = { ...process.env };
let sha = "";

before(() => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" }).trim();
  const repo = join(work, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  writeFileSync(join(repo, "a.txt"), "hello\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "one");
  sha = git(repo, "rev-parse", "HEAD");
  git(work, "clone", "-q", "--bare", repo, join(work, "bare.git"));
  // Two reviews in one process: the second extraction runs after a step set this.
  requireExplicitBareRepository(process.env);
});
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(work, { recursive: true, force: true });
});

for (const [kind, dir] of [
  ["a bare clone", "bare.git"],
  ["a clone with a work tree", "repo"],
] as const) {
  test(`extracts from ${kind} with safe.bareRepository=explicit in the environment`, async () => {
    const dest = join(work, `out-${dir}`);
    await new GitArchiveSnapshots(join(work, dir)).extract("head", sha, dest);
    assert.equal(readFileSync(join(dest, "a.txt"), "utf8"), "hello\n");
  });
}

test("control: git -C <bare clone> is refused with the setting", () => {
  assert.throws(() => execFileSync("git", ["-C", join(work, "bare.git"), "cat-file", "-e", `${sha}^{commit}`], { stdio: "pipe" }));
});
