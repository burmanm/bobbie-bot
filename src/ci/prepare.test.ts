/**
 * The prepare → review hand-over (C-4): `action/prepare.sh` packs the trees
 * and module cache, the review side extracts them with the validating
 * extractor and runs the pipeline on them. `gh` and `go` are fakes; no
 * network.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { main } from "../cli/main.ts";
import { assertInert } from "../core/markdown-testing.ts";
import { PreparedSnapshots, unpackSnapshot } from "./snapshot.ts";
import { runnerCommands } from "./workflow-commands-testing.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PREPARE = join(HERE, "..", "..", "action", "prepare.sh");
const FIXTURE = join(HERE, "..", "pipeline", "fixtures", "prs", "basic");
const PR = JSON.parse(readFileSync(join(FIXTURE, "pr.json"), "utf8")) as { repo: string; number: number; baseSha: string; headSha: string };

const work = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-prepare-")));
after(() => {
  // The fake module cache is read-only like Go's; make it removable.
  for (const d of readdirSync(work)) rmSync(join(work, d), { recursive: true, force: true, maxRetries: 2 });
  rmSync(work, { recursive: true, force: true });
});

const FAKE_GH = `#!/usr/bin/env bash
# gh api repos/<repo>/tarball/<sha>
set -euo pipefail
[[ "$1" == api ]] || exit 2
sha="\${2##*/}"
case "$sha" in
  "$FAKE_BASE") dir="$FAKE_TREES/base" ;;
  "$FAKE_HEAD") dir="$FAKE_TREES/head" ;;
  *) echo "no such commit" >&2; exit 1 ;;
esac
tmp="$(mktemp -d "$FAKE_TMP/gh.XXXXXX")"
mkdir "$tmp/owner-repo-$sha"
cp -R "$dir/." "$tmp/owner-repo-$sha/"
COPYFILE_DISABLE=1 tar -czf - -C "$tmp" "owner-repo-$sha"
rm -rf "$tmp"
`;

const FAKE_GO = `#!/usr/bin/env bash
# go mod download: record the environment, fill the module cache.
set -euo pipefail
[[ "$1 $2" == "mod download" ]] || exit 2
env | sort > "$HOME/go-env.txt"
pwd > "$HOME/go-cwd.txt"
if grep -q EVIL go.mod; then echo 'go: x\`![p](https://evil.example/p?q=1) @org/team <img src=x>' >&2; exit 1; fi
if grep -q HASH go.mod; then echo 'go: example.com/vendor/##[error]Your token expired@v1: 404' >&2; exit 1; fi
if grep -q FAIL go.mod; then echo "go: example.com/evil@v0.0.1: reading https://proxy/...: 404 Not Found" >&2; exit 1; fi
mkdir -p "$GOMODCACHE/example.com/lib@v1.2.3" "$GOMODCACHE/cache/download/example.com/lib/@v"
echo "package lib" > "$GOMODCACHE/example.com/lib@v1.2.3/lib.go"
echo zip > "$GOMODCACHE/cache/download/example.com/lib/@v/v1.2.3.zip"
echo "// written by go" >> go.mod
`;

function setup(name: string, mutateHead?: (dir: string) => void) {
  const dir = join(work, name);
  const bin = join(dir, "bin");
  const trees = join(dir, "trees");
  mkdirSync(bin, { recursive: true });
  cpSync(join(FIXTURE, "base"), join(trees, "base"), { recursive: true });
  cpSync(join(FIXTURE, "head"), join(trees, "head"), { recursive: true });
  mutateHead?.(join(trees, "head"));
  writeFileSync(join(bin, "gh"), FAKE_GH);
  writeFileSync(join(bin, "go"), FAKE_GO);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "go"), 0o755);
  return { dir, bin, trees, out: join(dir, "work") };
}

function runPrepare(s: ReturnType<typeof setup>, extra: Record<string, string> = {}): Promise<{ code: number; stderr: string }> {
  return new Promise((done) => {
    execFile(
      "bash",
      [PREPARE],
      {
        env: {
          PATH: `${s.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          GH_TOKEN: "token-that-go-must-not-see",
          RB_REPO: PR.repo,
          RB_PR: String(PR.number),
          RB_BASE_SHA: PR.baseSha,
          RB_HEAD_SHA: PR.headSha,
          RB_WORK: s.out,
          FAKE_TREES: s.trees,
          FAKE_TMP: s.dir,
          FAKE_BASE: PR.baseSha,
          FAKE_HEAD: PR.headSha,
          ...extra,
        },
      },
      (error, _stdout, stderr) => done({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr: String(stderr) }),
    );
  });
}

test("prepare packs base, head and the module cache; go runs hardened, on a copy, without the token", async () => {
  const s = setup("ok");
  const r = await runPrepare(s);
  assert.equal(r.code, 0, r.stderr);
  const archive = join(s.out, "out", "snapshot.tar.gz");
  assert.ok(existsSync(archive));

  const goEnv = readFileSync(join(s.out, "gohome", "go-env.txt"), "utf8");
  for (const kv of ["GOPROXY=https://proxy.golang.org", "GOSUMDB=sum.golang.org", "GOTOOLCHAIN=local", "GOVCS=*:off", "GOFLAGS=-mod=readonly -modcacherw", "GOWORK=off", "GOAUTH=off", "GONOSUMDB=", "GOPRIVATE=", "GOINSECURE="]) {
    assert.ok(goEnv.split("\n").includes(kv), `go env has ${kv}`);
  }
  assert.doesNotMatch(goEnv, /GH_TOKEN|GITHUB_TOKEN|token-that-go-must-not-see/);
  assert.match(readFileSync(join(s.out, "gohome", "go-cwd.txt"), "utf8"), /gomod-scratch/);

  const dest = join(s.dir, "unpacked");
  const { manifest } = await unpackSnapshot(archive, dest);
  assert.deepEqual([manifest.repo, manifest.pr, manifest.baseSha, manifest.headSha, manifest.modcache.status], [PR.repo, PR.number, PR.baseSha, PR.headSha, "ok"]);
  assert.equal(readFileSync(join(dest, "modcache", "example.com", "lib@v1.2.3", "lib.go"), "utf8"), "package lib\n");
  assert.equal(existsSync(join(dest, "modcache", "cache")), false, "zip downloads are dropped");
  // The packed head is the tree as fetched: go's edit of go.mod happened on the scratch copy.
  assert.equal(readFileSync(join(dest, "head", "go.mod"), "utf8"), readFileSync(join(FIXTURE, "head", "go.mod"), "utf8"));
  assert.equal(readFileSync(join(dest, "base", "REVIEW.md"), "utf8"), readFileSync(join(FIXTURE, "base", "REVIEW.md"), "utf8"));

  // The review side: the pipeline runs on the prepared trees with the prepared module cache.
  const runs = join(s.dir, "runs");
  const out = { stdout: "", stderr: "" };
  const code = await main(
    ["review", "--dry-run", "--fixture", FIXTURE, "--snapshot-dir", dest, "--script", join(FIXTURE, "script.json"), "--runs-dir", runs, "--quiet"],
    { stdout: (t) => void (out.stdout += t), stderr: (t) => void (out.stderr += t) },
  );
  assert.equal(code, 0, out.stderr);
  const payload = JSON.parse(out.stdout) as { check_run: { conclusion: string } };
  assert.equal(payload.check_run.conclusion, "success");
  const runDir = join(runs, readdirSync(runs)[0]!);
  const intake = readFileSync(join(runDir, "01-intake.json"), "utf8");
  assert.match(intake, new RegExp(`"modcache": "${join(dest, "modcache").replace(/[/\\]/g, "\\$&")}"`));
});

test("a failing go mod download still produces a snapshot, without a module cache, and says why", async () => {
  const s = setup("fail", (head) => writeFileSync(join(head, "go.mod"), "module example.com/widget\n\ngo 1.22\n\n// FAIL\n"));
  const r = await runPrepare(s);
  assert.equal(r.code, 0, r.stderr);
  const dest = join(s.dir, "unpacked");
  const { manifest } = await unpackSnapshot(join(s.out, "out", "snapshot.tar.gz"), dest);
  assert.equal(manifest.modcache.status, "failed");
  assert.match(manifest.modcache.detail ?? "", /go mod download failed/);
  assert.equal(existsSync(join(dest, "modcache")), false);
});

test("go's error, which the PR controls, is inert in the job summary (H-51)", async () => {
  const s = setup("summary", (head) => writeFileSync(join(head, "go.mod"), "module example.com/widget\n\n// EVIL\n"));
  const summary = join(s.dir, "summary.md");
  assert.equal((await runPrepare(s, { GITHUB_STEP_SUMMARY: summary })).code, 0);
  const text = readFileSync(summary, "utf8");
  assert.match(text, /evil\.example/);
  assertInert(text);
});

test("no go.mod → modcache skipped; a module cache over the cap is dropped", async () => {
  const s = setup("nogo", (head) => rmSync(join(head, "go.mod")));
  assert.equal((await runPrepare(s)).code, 0);
  const a = await unpackSnapshot(join(s.out, "out", "snapshot.tar.gz"), join(s.dir, "u1"));
  assert.equal(a.manifest.modcache.status, "skipped");

  const big = setup("big");
  assert.equal((await runPrepare(big, { RB_MODCACHE_MAX_MB: "0" })).code, 0);
  const b = await unpackSnapshot(join(big.out, "out", "snapshot.tar.gz"), join(big.dir, "u2"));
  assert.equal(b.manifest.modcache.status, "too-large");
});

test("prepare refuses bad inputs before fetching anything", async () => {
  const s = setup("bad");
  for (const extra of [{ RB_HEAD_SHA: "main" }, { RB_REPO: "o/r;rm -rf /" }, { RB_GOPROXY: "https://proxy.golang.org,direct" }, { RB_GO_MODULES: "../x" }]) {
    const r = await runPrepare(s, extra);
    assert.notEqual(r.code, 0, JSON.stringify(extra));
  }
});

test("the review side only hands out the prepared SHAs, for the prepared PR", async () => {
  const s = setup("sha");
  assert.equal((await runPrepare(s)).code, 0);
  const dest = join(s.dir, "unpacked");
  await unpackSnapshot(join(s.out, "out", "snapshot.tar.gz"), dest);
  const prepared = new PreparedSnapshots(dest);
  assert.throws(() => prepared.assertFor(PR.repo, PR.number + 1), /not/);
  prepared.assertFor(PR.repo.toUpperCase(), PR.number);
  await assert.rejects(prepared.extract("head", "f".repeat(40), join(s.dir, "x")), /PR changed after the snapshots were prepared/);
  await prepared.extract("head", PR.headSha, join(s.dir, "y"));
  assert.ok(existsSync(join(s.dir, "y", "go.mod")));
});

test("H-55: go's error text (from the PR's go.mod) is logged with workflow commands stopped", async () => {
  const s = setup("hash", (head) => writeFileSync(join(head, "go.mod"), "module example.com/widget\n\n// HASH\n"));
  const r = await runPrepare(s);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /vendor\/##\[error\]Your token expired/);
  assert.deepEqual(runnerCommands(r.stderr), []);
});
