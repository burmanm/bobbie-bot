/**
 * `action/run.sh` with a fake `docker`: which environment, mounts and
 * arguments each container gets (C-3, C-3a, C-5). No Docker needed.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const ACTION = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "action");
const work = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-runsh-")));
after(() => rmSync(work, { recursive: true, force: true }));

const FAKE_DOCKER = `#!/usr/bin/env bash
# Records each call as one line of NUL-free, tab-joined argv.
(IFS=$'\\t'; echo "$*") >> "$FAKE_LOG"
[[ "$1" == image ]] && exit "\${FAKE_IMAGE_MISSING:-0}"
[[ "$1" == rm ]] && exit 0
prev=""
for a in "$@"; do
  if [[ "$prev" == -v && "$a" == *:/github/out ]]; then
    d="\${a%:/github/out}"
    printf 'review=true\\nhead-sha=%s\\n' "$(printf 'a%.0s' {1..40})" > "$d/output"
    echo "gate summary" > "$d/summary.md"
  fi
  # fetch-agent-dir writes the directory (F-7).
  if [[ "$prev" == -v && "$a" == *:/agent-out ]]; then mkdir -p "\${a%:/agent-out}/dir"; fi
  prev="$a"
done
# fetch-agent-dir: its --dest under the /agent-out mount, with FAKE_FETCH_FILES in it.
if [[ " $* " == *" fetch-agent-dir "* ]]; then
  host="" dest="" p=""
  for a in "$@"; do
    [[ "$p" == -v && "$a" == *:/agent-out ]] && host="\${a%:/agent-out}"
    [[ "$p" == --dest ]] && dest="$a"
    p="$a"
  done
  d="$host\${dest#/agent-out}"
  mkdir -p "$d"
  for f in \${FAKE_FETCH_FILES:-}; do echo x > "$d/$f"; done
  echo "fetched from o/r@$(printf 'c%.0s' {1..40})" >&2
fi
[[ " $* " == *" launch --pr "* ]] && exit "\${FAKE_EXIT:-0}"
exit 0
`;
const FAKE_TIMEOUT = `#!/usr/bin/env bash
while [[ "$1" == --* ]]; do shift; done
shift
exec "$@"
`;

let n = 0;
function setup() {
  const dir = join(work, `t${n++}`);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  writeFileSync(join(bin, "timeout"), FAKE_TIMEOUT);
  chmodSync(join(bin, "docker"), 0o755);
  chmodSync(join(bin, "timeout"), 0o755);
  writeFileSync(join(dir, "event.json"), "{}");
  writeFileSync(join(dir, "output"), "");
  writeFileSync(join(dir, "summary"), "");
  return { dir, bin, log: join(dir, "docker.log") };
}

function run(s: ReturnType<typeof setup>, env: Record<string, string>, mode = "run", actionDir = ACTION): Promise<{ code: number; stderr: string; calls: string[][] }> {
  return new Promise((done) => {
    execFile(
      "bash",
      [join(actionDir, "run.sh"), mode],
      {
        env: {
          PATH: `${s.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          RUNNER_TEMP: s.dir,
          GITHUB_ACTION_PATH: actionDir,
          GITHUB_EVENT_PATH: join(s.dir, "event.json"),
          GITHUB_OUTPUT: join(s.dir, "output"),
          GITHUB_STEP_SUMMARY: join(s.dir, "summary"),
          GITHUB_RUN_ID: "99",
          FAKE_LOG: s.log,
          GH_TOKEN: "ghs_secret_github_token",
          RB_REPO: "k8ssandra/cass-operator",
          ...env,
        },
      },
      (error, stdout, stderr) => {
        let calls: string[][] = [];
        try {
          calls = readFileSync(s.log, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
        } catch {
          calls = [];
        }
        // Workflow commands (::warning::) go to stdout; both streams are the step log.
        done({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr: `${String(stdout)}${String(stderr)}`, calls });
      },
    );
  });
}

const flagValues = (argv: string[], flag: string) => argv.flatMap((a, i) => (argv[i - 1] === flag ? [a] : []));

test("gate: token passed by name, event read-only, well-formed outputs forwarded", async () => {
  const s = setup();
  const r = await run(s, { RB_COMMAND: "gate", RB_NAME: "main", RB_AUTH_LABEL: "ai-review/approved", RB_AUTH_LIFETIME: "per-pr" });
  assert.equal(r.code, 0, r.stderr);
  const argv = r.calls[0]!;
  assert.ok(flagValues(argv, "-e").includes("GH_TOKEN"));
  assert.ok(!argv.join(" ").includes("ghs_secret_github_token"));
  assert.ok(flagValues(argv, "-v").includes(`${join(s.dir, "event.json")}:/github/event.json:ro`));
  assert.deepEqual(argv.slice(argv.indexOf("review-bot-action:local") + 1), ["gate", "--repo", "k8ssandra/cass-operator", "--name", "main", "--records-dir", "/github/out/records", "--label", "ai-review/approved", "--lifetime", "per-pr"]);
  assert.match(readFileSync(join(s.dir, "output"), "utf8"), /^review=true\nhead-sha=a{40}\n$/);
  assert.match(readFileSync(join(s.dir, "summary"), "utf8"), /gate summary/);
});

test("review: extraction offline and keyless; the review gets the snapshot read-only and only named provider keys", async () => {
  const s = setup();
  mkdirSync(join(s.dir, "review-bot", "in"), { recursive: true });
  writeFileSync(join(s.dir, "review-bot", "in", "snapshot.tar.gz"), "");
  const r = await run(s, {
    RB_COMMAND: "review",
    RB_PR: "1021",
    RB_NAME: "main",
    RB_MODELS: "reviewer=openrouter/vendor/model-a\n  verifier=openrouter/vendor/model-b  \n",
    RB_THINKING: "verifier=low",
    RB_MAX_COST: "3",
    RB_TIMEOUT_MINUTES: "30",
    OPENROUTER_API_KEY: "sk-or-secret",
    UNRELATED_SECRET: "nope",
  });
  assert.equal(r.code, 0, r.stderr);
  const runs = r.calls.filter((c) => c[0] === "run");
  assert.equal(runs.length, 2);
  const [unpack, review] = runs as [string[], string[]];
  assert.ok(unpack.includes("--network") && flagValues(unpack, "--network").includes("none"));
  assert.ok(!flagValues(unpack, "-e").some((e) => e.startsWith("GH_TOKEN") || e.startsWith("OPENROUTER")));
  assert.ok(unpack.includes("unpack-snapshot"));

  const env = flagValues(review, "-e");
  assert.ok(env.includes("GH_TOKEN") && env.includes("OPENROUTER_API_KEY") && env.includes("PI_OFFLINE=1"));
  assert.ok(!env.some((e) => e.startsWith("UNRELATED_SECRET")));
  assert.ok(!review.join(" ").includes("sk-or-secret") && !review.join(" ").includes("ghs_secret"));
  assert.ok(flagValues(review, "-v").includes(`${join(s.dir, "review-bot", "snapshot")}:/snapshot:ro`));
  for (const f of ["--cap-drop", "--read-only", "--security-opt"]) assert.ok(review.includes(f), f);
  const cli = review.slice(review.indexOf("review-bot-action:local") + 1);
  assert.deepEqual(cli, [
    // The pi command /review-bot through the launcher (F-3), not the plain CLI.
    "launch", "--pr", "k8ssandra/cass-operator#1021", "--snapshot-dir", "/snapshot", "--runs-dir", "/runs", "--name", "main",
    "--model", "reviewer=openrouter/vendor/model-a", "--model", "verifier=openrouter/vendor/model-b", "--thinking", "verifier=low", "--max-cost", "3",
    // 30 min step: container stopped at 29 min, run deadline at most 2 min inside that (S-9).
    "--max-run-timeout", "1620s",
  ]);
  assert.ok(!cli.includes("--dry-run"));
});

test("review: refuses GitHub tokens as provider keys, malformed models, a missing snapshot", async () => {
  const s = setup();
  mkdirSync(join(s.dir, "review-bot", "in"), { recursive: true });
  writeFileSync(join(s.dir, "review-bot", "in", "snapshot.tar.gz"), "");
  const base = { RB_COMMAND: "review", RB_PR: "5" };
  assert.equal((await run(s, { ...base, RB_PROVIDER_ENV: "OPENROUTER_API_KEY,GITHUB_TOKEN" })).code, 2);
  assert.equal((await run(s, { ...base, RB_MODELS: "judge=openrouter/x" })).code, 2);
  assert.equal((await run(s, { ...base, RB_MODELS: "reviewer=a b" })).code, 2);
  assert.equal((await run(s, { ...base, RB_PR: "5; rm -rf /" })).code, 2);
  const empty = setup();
  assert.equal((await run(empty, base)).code, 2);
});

test("review: exit 1 (neutral, check completed) keeps the step green; a timeout fails it", async () => {
  const s = setup();
  mkdirSync(join(s.dir, "review-bot", "in"), { recursive: true });
  writeFileSync(join(s.dir, "review-bot", "in", "snapshot.tar.gz"), "");
  const neutral = await run(s, { RB_COMMAND: "review", RB_PR: "5", FAKE_EXIT: "1" });
  assert.equal(neutral.code, 0);
  assert.match(neutral.stderr, /could not complete; ai-review\/main is neutral/);
  assert.equal((await run(s, { RB_COMMAND: "review", RB_PR: "5", FAKE_EXIT: "124" })).code, 1);
});

test("complete-check and remove-label validate their inputs", async () => {
  const s = setup();
  assert.equal((await run(s, { RB_COMMAND: "complete-check", RB_HEAD_SHA: "abc" })).code, 2);
  assert.equal((await run(s, { RB_COMMAND: "complete-check", RB_HEAD_SHA: "a".repeat(40), RB_OUTCOME: "x;y" })).code, 2);
  const ok = await run(s, { RB_COMMAND: "complete-check", RB_HEAD_SHA: "a".repeat(40), RB_OUTCOME: "cancelled" });
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(ok.calls.at(-1)!.slice(-8), ["complete-check", "--repo", "k8ssandra/cass-operator", "--name", "main", "--head-sha", "a".repeat(40), "--outcome", "cancelled"].slice(-8));
  assert.equal((await run(s, { RB_COMMAND: "remove-label" })).code, 2);
  assert.equal((await run(s, { RB_COMMAND: "nope" })).code, 2);
});

test("gate: CI-wait inputs become flags; --ignore-ci only on a manual dispatch; bad values refused", async () => {
  const s = setup();
  const r = await run(s, { RB_COMMAND: "gate", RB_CI_REQUIRE: "build, lint", RB_CI_ON_FAILURE: "review", RB_CI_TIMEOUT: "3h", RB_IGNORE_CI: "true", GITHUB_EVENT_NAME: "workflow_dispatch" });
  assert.equal(r.code, 0, r.stderr);
  const cli = r.calls[0]!.slice(r.calls[0]!.indexOf("review-bot-action:local") + 1);
  assert.deepEqual(cli.slice(-7), ["--ci-require", "build, lint", "--ci-on-failure", "review", "--ci-timeout", "3h", "--ignore-ci"]);
  const push = await run(setup(), { RB_COMMAND: "gate", RB_IGNORE_CI: "true", GITHUB_EVENT_NAME: "pull_request_target" });
  assert.ok(!push.calls[0]!.includes("--ignore-ci"));
  for (const bad of [{ RB_CI_ON_FAILURE: "maybe" }, { RB_CI_TIMEOUT: "6h; id" }, { RB_CI_REQUIRE: "a\tb" }]) {
    assert.equal((await run(setup(), { RB_COMMAND: "gate", ...bad })).code, 2, JSON.stringify(bad));
  }
});

test("review: the gate's waiting line and no-history are passed on; a multi-line waiting value is refused", async () => {
  const mk = () => {
    const s = setup();
    mkdirSync(join(s.dir, "review-bot", "in"), { recursive: true });
    writeFileSync(join(s.dir, "review-bot", "in", "snapshot.tar.gz"), "");
    return s;
  };
  const waiting = '{"headSeenAt":"2026-11-20T09:00:00Z","ci":"passed"}';
  const r = await run(mk(), { RB_COMMAND: "review", RB_PR: "5", RB_WAITING: waiting, RB_NO_HISTORY: "true" });
  assert.equal(r.code, 0, r.stderr);
  const review = r.calls.filter((c) => c[0] === "run")[1]!;
  assert.deepEqual(flagValues(review, "--waiting"), [waiting]);
  assert.ok(review.includes("--no-history"));
  assert.equal((await run(mk(), { RB_COMMAND: "review", RB_PR: "5", RB_WAITING: '{"a":\n1}' })).code, 2);
});

test("image (C-4): a digest in image.lock is pulled, never built; no digest builds; a tag is refused", async () => {
  const actionDir = (lock: string) => {
    const d = join(work, `action${n++}`);
    mkdirSync(d);
    writeFileSync(join(d, "run.sh"), readFileSync(join(ACTION, "run.sh")));
    writeFileSync(join(d, "image.lock"), lock);
    return d;
  };
  const ref = `ghcr.io/example/review-bot-action@sha256:${"e".repeat(64)}`;
  const pulled = await run(setup(), { FAKE_IMAGE_MISSING: "1" }, "build", actionDir(`# comment\n\n${ref}\n`));
  assert.equal(pulled.code, 0, pulled.stderr);
  assert.deepEqual(pulled.calls.map((c) => c[0]), ["image", "pull", "tag"]);
  assert.deepEqual(pulled.calls[1], ["pull", "--quiet", ref]);
  assert.deepEqual(pulled.calls[2], ["tag", ref, "review-bot-action:local"]);

  const built = await run(setup(), { FAKE_IMAGE_MISSING: "1" }, "build", actionDir("# no image published yet\n"));
  assert.equal(built.code, 0, built.stderr);
  assert.deepEqual(built.calls.map((c) => c[0]), ["image", "build"]);
  // The input wins over the lock: "build", or another digest.
  const forced = await run(setup(), { FAKE_IMAGE_MISSING: "1", RB_IMAGE: "build" }, "build", actionDir(`${ref}\n`));
  assert.deepEqual(forced.calls.map((c) => c[0]), ["image", "build"]);
  for (const bad of ["ghcr.io/example/review-bot-action:latest", `ghcr.io/example/x@sha256:${"e".repeat(63)}`, `${ref};id`]) {
    const r = await run(setup(), { FAKE_IMAGE_MISSING: "1", RB_IMAGE: bad }, "build", actionDir(""));
    assert.equal(r.code, 2, bad);
    assert.ok(!r.calls.some((c) => c[0] === "pull" || c[0] === "build"), bad);
  }
  // The repository's own lock names no image or exactly one digest.
  const lock = readFileSync(join(ACTION, "image.lock"), "utf8").split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  assert.ok(lock.length === 0 || (lock.length === 1 && /@sha256:[0-9a-f]{64}$/.test(lock[0]!.trim())), lock.join("|"));
});

test("agent directory (F-7): the gate fetches it from the default branch or a pinned commit and mounts it read-only", async () => {
  const s = setup();
  const r = await run(s, { RB_COMMAND: "gate", RB_AGENT_DIR: ".github/review-bot" });
  assert.equal(r.code, 0, r.stderr);
  const [fetch, gate] = r.calls.filter((c) => c[0] === "run") as [string[], string[]];
  assert.deepEqual(fetch.slice(fetch.indexOf("review-bot-action:local") + 1), ["fetch-agent-dir", "--path", ".github/review-bot", "--dest", "/agent-out/dir", "--repo", "k8ssandra/cass-operator"]);
  assert.ok(flagValues(fetch, "-e").includes("GH_TOKEN") && !flagValues(fetch, "-e").some((e) => e.startsWith("OPENROUTER")));
  assert.ok(flagValues(gate, "-v").includes(`${join(s.dir, "review-bot", "agent", "dir")}:/agent:ro`));
  assert.deepEqual(flagValues(gate, "--agent-dir"), ["/agent"]);
  assert.ok(!gate.includes("--label") && !gate.includes("--lifetime"), "unset inputs leave settings.json's values");

  const pinned = await run(setup(), { RB_COMMAND: "gate", RB_AGENT_DIR: "agent", RB_AGENT_DIR_REPO: `org/config@${"e".repeat(40)}` });
  assert.equal(pinned.code, 0, pinned.stderr);
  const f = pinned.calls.find((c) => c.includes("fetch-agent-dir"))!;
  assert.deepEqual(f.slice(f.indexOf("fetch-agent-dir")), ["fetch-agent-dir", "--path", "agent", "--dest", "/agent-out/dir", "--repo", "org/config", "--ref", "e".repeat(40)]);

  for (const bad of [{ RB_AGENT_DIR: "../etc" }, { RB_AGENT_DIR: "/abs" }, { RB_AGENT_DIR: "a/./b" }, { RB_AGENT_DIR: "a b" }, { RB_AGENT_DIR: "a", RB_AGENT_DIR_REPO: "org/config@main" }, { RB_AGENT_DIR: "a", RB_AGENT_DIR_REPO: "org/config" }]) {
    const res = await run(setup(), { RB_COMMAND: "gate", ...bad });
    assert.equal(res.code, 2, JSON.stringify(bad));
    assert.ok(!res.calls.some((c) => c.includes("fetch-agent-dir")), JSON.stringify(bad));
  }
});

test("agent directory (F-7): the review unpacks the setup job's archive offline and mounts it read-only; never fetches; without it the step fails", async () => {
  const mk = () => {
    const s = setup();
    mkdirSync(join(s.dir, "review-bot", "in"), { recursive: true });
    writeFileSync(join(s.dir, "review-bot", "in", "snapshot.tar.gz"), "");
    return s;
  };
  const s = mk();
  mkdirSync(join(s.dir, "review-bot", "agent-in"), { recursive: true });
  writeFileSync(join(s.dir, "review-bot", "agent-in", "agent-dir.tar.gz"), "");
  // The gate's copy is not what the review uses, even when present.
  mkdirSync(join(s.dir, "review-bot", "agent", "dir"), { recursive: true });
  const r = await run(s, { RB_COMMAND: "review", RB_PR: "5", RB_AGENT_DIR: ".github/review-bot", OPENROUTER_API_KEY: "sk-or-secret" });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.calls.some((c) => c.includes("fetch-agent-dir") || c.includes("setup")));
  const runs = r.calls.filter((c) => c[0] === "run");
  assert.equal(runs.length, 3);
  const unpack = runs.find((c) => c.includes("unpack-agent-dir"))!;
  assert.deepEqual(flagValues(unpack, "--network"), ["none"]);
  assert.ok(!flagValues(unpack, "-e").some((e) => e.startsWith("GH_TOKEN") || e.startsWith("OPENROUTER")));
  assert.ok(flagValues(unpack, "-v").includes(`${join(s.dir, "review-bot", "agent-in")}:/in:ro`));
  assert.deepEqual(unpack.slice(unpack.indexOf("unpack-agent-dir")), ["unpack-agent-dir", "--archive", "/in/agent-dir.tar.gz", "--dest", "/out"]);
  const review = runs.at(-1)!;
  assert.ok(review.includes("launch"));
  assert.ok(flagValues(review, "-v").includes(`${join(s.dir, "review-bot", "agent-installed", "agent")}:/agent:ro`));
  assert.ok(!flagValues(review, "-v").some((v) => v.startsWith(join(s.dir, "review-bot", "agent", "dir"))));
  assert.deepEqual(flagValues(review, "--agent-dir"), ["/agent"]);
  assert.deepEqual(flagValues(review, "--max-run-timeout"), ["2220s"], "a ceiling, so lower configured values apply");
  assert.ok(!review.includes("--run-timeout"));

  const missing = await run(mk(), { RB_COMMAND: "review", RB_PR: "5", RB_AGENT_DIR: ".github/review-bot" });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /agent-dir is set but .*agent-dir\.tar\.gz is missing/);
  const thinking = await run(mk(), { RB_COMMAND: "review", RB_PR: "5", RB_THINKING: "reviewer=xhigh\nverifier=max" });
  assert.equal(thinking.code, 0, thinking.stderr);
});

test("setup (F-7, C-4): installs with network but no token or key, under /agent with the review's read roots, then packs offline", async () => {
  const s = setup();
  const agent = join(s.dir, "review-bot", "agent", "dir");
  mkdirSync(agent, { recursive: true });
  const r = await run(s, { RB_COMMAND: "setup", RB_AGENT_DIR: ".github/review-bot", OPENROUTER_API_KEY: "sk-or-secret" });
  assert.equal(r.code, 0, r.stderr);
  const runs = r.calls.filter((c) => c[0] === "run");
  assert.equal(runs.length, 2);
  const [install, pack] = runs as [string[], string[]];
  for (const c of runs) {
    // No token and no key in either container, by name or by value.
    assert.deepEqual(flagValues(c, "-e"), ["HOME=/tmp"]);
    assert.ok(!c.join(" ").includes("ghs_secret") && !c.join(" ").includes("sk-or-secret"));
    for (const f of ["--cap-drop", "--read-only", "--security-opt", "--init"]) assert.ok(c.includes(f), f);
  }
  // Installers need the network; the pack step does not get it.
  assert.deepEqual(flagValues(install, "--network"), []);
  assert.deepEqual(flagValues(pack, "--network"), ["none"]);
  assert.deepEqual(flagValues(install, "-v"), [`${agent}:/agent`]);
  assert.deepEqual(install.slice(install.indexOf("review-bot-action:local") + 1), ["setup", "--agent-dir", "/agent", "--read-root", "/snapshot", "--read-root", "/runs"]);
  assert.deepEqual(flagValues(pack, "-v"), [`${agent}:/in/agent:ro`, `${join(s.dir, "review-bot", "agent-out")}:/out`]);
  assert.deepEqual(flagValues(pack, "--entrypoint"), ["tar"]);
  const tarArgs = pack.slice(pack.indexOf("review-bot-action:local") + 1);
  assert.ok(tarArgs.includes("--hard-dereference"), "the review's extractor refuses hard links");
  assert.deepEqual(tarArgs.slice(-3), ["--directory", "/in", "agent"]);
  assert.ok(tarArgs.includes("/out/agent-dir.tar.gz"));

  assert.equal((await run(setup(), { RB_COMMAND: "setup" })).code, 2, "no agent-dir");
  const missing = await run(setup(), { RB_COMMAND: "setup", RB_AGENT_DIR: ".github/review-bot" });
  assert.equal(missing.code, 2);
  assert.equal(missing.calls.filter((c) => c[0] === "run").length, 0);
  assert.equal((await run(setup(), { RB_COMMAND: "setup", RB_AGENT_DIR: "../x" })).code, 2);
});

test("knowledge (pilot prototype): the gate fetches it and the guidelines into the agent directory; the review passes --knowledge-dir and --acp-config", async () => {
  const sha = "c".repeat(40);
  const s = setup();
  const r = await run(s, {
    RB_COMMAND: "gate",
    RB_AGENT_DIR: ".github/review-bot",
    RB_KNOWLEDGE: "org/process:pilot/cass-operator",
    RB_KNOWLEDGE_GUIDELINES: "shared/go-operator-guidelines.md\n",
    FAKE_FETCH_FILES: "go-operator-guidelines.md",
  });
  assert.equal(r.code, 0, r.stderr);
  const fetches = r.calls.filter((c) => c.includes("fetch-agent-dir")).map((c) => c.slice(c.indexOf("fetch-agent-dir")));
  assert.deepEqual(fetches, [
    ["fetch-agent-dir", "--path", ".github/review-bot", "--dest", "/agent-out/dir", "--repo", "k8ssandra/cass-operator"],
    ["fetch-agent-dir", "--path", "pilot/cass-operator", "--dest", "/agent-out/dir/knowledge", "--repo", "org/process"],
    // The guidelines at the commit the knowledge came from.
    ["fetch-agent-dir", "--path", "shared", "--dest", "/agent-out/guidelines-1", "--repo", "org/process", "--ref", sha],
  ]);
  for (const f of r.calls.filter((c) => c.includes("fetch-agent-dir"))) {
    assert.ok(!flagValues(f, "-e").some((e) => e.startsWith("OPENROUTER") || e.startsWith("AGENT")));
  }
  const knowledge = join(s.dir, "review-bot", "agent", "dir", "knowledge");
  assert.equal(readFileSync(join(knowledge, ".review", "go-operator-guidelines.md"), "utf8"), "x\n");
  assert.ok(!existsSync(join(s.dir, "review-bot", "agent", "guidelines-1")), "the temporary copy is removed");

  // A pinned knowledge commit is used for both fetches.
  const pinned = await run(setup(), { RB_COMMAND: "gate", RB_AGENT_DIR: "a", RB_KNOWLEDGE: `o/r@${"d".repeat(40)}:k`, RB_KNOWLEDGE_GUIDELINES: "x/y-guidelines.md", FAKE_FETCH_FILES: "y-guidelines.md" });
  assert.equal(pinned.code, 0, pinned.stderr);
  assert.deepEqual(pinned.calls.filter((c) => c.includes("fetch-agent-dir")).map((c) => flagValues(c, "--ref")), [[], ["d".repeat(40)], ["d".repeat(40)]]);

  for (const bad of [
    { RB_KNOWLEDGE: "o/r:pilot" }, // no agent-dir
    { RB_AGENT_DIR: "a", RB_KNOWLEDGE: "o/r" },
    { RB_AGENT_DIR: "a", RB_KNOWLEDGE: "o/r@main:pilot" },
    { RB_AGENT_DIR: "a", RB_KNOWLEDGE: "o/r:../x" },
    { RB_AGENT_DIR: "a", RB_KNOWLEDGE: "o/r:/abs" },
    { RB_AGENT_DIR: "a", RB_KNOWLEDGE: "o/r:k", RB_KNOWLEDGE_GUIDELINES: "shared/notes.md" },
    { RB_AGENT_DIR: "a", RB_KNOWLEDGE: "o/r:k", RB_KNOWLEDGE_GUIDELINES: "top-guidelines.md" },
    { RB_AGENT_DIR: "a", RB_KNOWLEDGE: "o/r:k", RB_KNOWLEDGE_GUIDELINES: "../x/y-guidelines.md" },
    { RB_AGENT_DIR: "a", RB_KNOWLEDGE: "o/r:k", RB_KNOWLEDGE_GUIDELINES: "x/missing-guidelines.md" },
    { RB_ACP_CONFIG: "acp.json" }, // no agent-dir
    { RB_AGENT_DIR: "a", RB_ACP_CONFIG: "../acp.json" },
  ]) {
    const res = await run(setup(), { RB_COMMAND: "gate", ...bad });
    assert.equal(res.code, 2, `${JSON.stringify(bad)}\n${res.stderr}`);
  }

  // The review: knowledge/ and acp.json come from the setup job's archive.
  const mk = () => {
    const t = setup();
    mkdirSync(join(t.dir, "review-bot", "in"), { recursive: true });
    writeFileSync(join(t.dir, "review-bot", "in", "snapshot.tar.gz"), "");
    mkdirSync(join(t.dir, "review-bot", "agent-in"), { recursive: true });
    writeFileSync(join(t.dir, "review-bot", "agent-in", "agent-dir.tar.gz"), "");
    return t;
  };
  // The fake unpack writes nothing, so the installed tree is planted after the
  // step deletes it: run the step through a docker that creates it.
  const t = mk();
  const fake = readFileSync(join(t.bin, "docker"), "utf8").replace(
    "#!/usr/bin/env bash\n",
    `#!/usr/bin/env bash\nif [[ " $* " == *" unpack-agent-dir "* ]]; then o="${join(t.dir, "review-bot", "agent-installed", "agent")}"; mkdir -p "$o/knowledge"; echo '{}' > "$o/acp.json"; fi\n`,
  );
  writeFileSync(join(t.bin, "docker"), fake);
  const rv = await run(t, { RB_COMMAND: "review", RB_PR: "5", RB_AGENT_DIR: "a", RB_KNOWLEDGE: "o/r:k", RB_ACP_CONFIG: "acp.json", RB_PROVIDER_ENV: "AGENT_API_KEY", AGENT_API_KEY: "agent-secret" });
  assert.equal(rv.code, 0, rv.stderr);
  const review = rv.calls.filter((c) => c[0] === "run").at(-1)!;
  assert.deepEqual(flagValues(review, "--knowledge-dir"), ["/agent/knowledge"]);
  assert.deepEqual(flagValues(review, "--acp-config"), ["/agent/acp.json"]);
  assert.ok(flagValues(review, "-e").includes("AGENT_API_KEY"));
  assert.ok(!review.includes("fetch-agent-dir"));

  const noAcp = await run(mk(), { RB_COMMAND: "review", RB_PR: "5", RB_AGENT_DIR: "a", RB_ACP_CONFIG: "acp.json" });
  assert.equal(noAcp.code, 2);
  assert.match(noAcp.stderr, /no file acp\.json/);
});
