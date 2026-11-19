/**
 * `action/run.sh` with a fake `docker`: which environment, mounts and
 * arguments each container gets (C-3, C-3a, C-5). No Docker needed.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
[[ "$1" == image ]] && exit 0
[[ "$1" == rm ]] && exit 0
prev=""
for a in "$@"; do
  if [[ "$prev" == -v && "$a" == *:/github/out ]]; then
    d="\${a%:/github/out}"
    printf 'review=true\\nhead-sha=%s\\n' "$(printf 'a%.0s' {1..40})" > "$d/output"
    echo "gate summary" > "$d/summary.md"
  fi
  prev="$a"
done
[[ " $* " == *" review --pr "* ]] && exit "\${FAKE_EXIT:-0}"
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

function run(s: ReturnType<typeof setup>, env: Record<string, string>): Promise<{ code: number; stderr: string; calls: string[][] }> {
  return new Promise((done) => {
    execFile(
      "bash",
      [join(ACTION, "run.sh"), "run"],
      {
        env: {
          PATH: `${s.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          RUNNER_TEMP: s.dir,
          GITHUB_ACTION_PATH: ACTION,
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
  assert.deepEqual(argv.slice(argv.indexOf("review-bot-action:local") + 1), ["gate", "--repo", "k8ssandra/cass-operator", "--name", "main", "--label", "ai-review/approved", "--lifetime", "per-pr"]);
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
    "review", "--pr", "k8ssandra/cass-operator#1021", "--snapshot-dir", "/snapshot", "--runs-dir", "/runs", "--name", "main",
    "--model", "reviewer=openrouter/vendor/model-a", "--model", "verifier=openrouter/vendor/model-b", "--thinking", "verifier=low", "--max-cost", "3",
    // 30 min step: container stopped at 29 min, run deadline 2 min inside that (S-9).
    "--run-timeout", "1620s",
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
