/** The CLI dry-runs the fixture PR end to end with the scripted model (R-1 "done when"). */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { main } from "./main.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "pipeline", "fixtures", "prs", "basic");
const work = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-cli-")));
after(() => rmSync(work, { recursive: true, force: true }));

function io() {
  const out = { stdout: "", stderr: "" };
  return { out, io: { stdout: (s: string) => void (out.stdout += s), stderr: (s: string) => void (out.stderr += s) } };
}

test("review --dry-run --fixture --script prints and writes the would-be review", async () => {
  const out = join(work, "review.json");
  const cap = io();
  const code = await main(
    [
      "review",
      "--dry-run",
      "--fixture",
      FIXTURE,
      "--script",
      join(FIXTURE, "script.json"),
      "--no-modcache",
      "--runs-dir",
      join(work, "runs"),
      "--out",
      out,
      "--quiet",
    ],
    cap.io,
  );
  assert.equal(code, 0, cap.out.stderr);
  const payload = JSON.parse(cap.out.stdout) as { review: { event: string; comments: unknown[] }; check_run: { conclusion: string } };
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), payload);
  assert.equal(payload.review.event, "COMMENT");
  assert.equal(payload.review.comments.length, 2);
  assert.equal(payload.check_run.conclusion, "success");
});

test("usage errors: a fixture without --dry-run, both sources, a bad role", async () => {
  const cap = io();
  assert.equal(await main(["review", "--fixture", FIXTURE], cap.io), 2);
  assert.match(cap.out.stderr, /--fixture needs --dry-run/);
  assert.equal(await main(["review", "--dry-run", "--fixture", FIXTURE, "--pr", "o/r#1"], cap.io), 2);
  assert.equal(await main(["review", "--dry-run", "--fixture", FIXTURE, "--model", "judge=openrouter/x/y"], cap.io), 2);
});

test("usage error: --head without --dry-run is never posted", async () => {
  const cap = io();
  assert.equal(await main(["review", "--pr", "o/r#1", "--head", "abc1234"], cap.io), 2);
  assert.match(cap.out.stderr, /--head needs --dry-run/);
});

test("without a model the run completes neutral instead of picking one (P-4)", async () => {
  const cap = io();
  const code = await main(["review", "--dry-run", "--fixture", FIXTURE, "--no-modcache", "--runs-dir", join(work, "runs"), "--quiet"], cap.io);
  assert.equal(code, 1);
  const payload = JSON.parse(cap.out.stdout) as { check_run: { conclusion: string; output: { summary: string } } };
  assert.equal(payload.check_run.conclusion, "neutral");
  assert.match(payload.check_run.output.summary, /no model is configured for the reviewer role/);
});

test("timeout flags: bad durations and roles are usage errors; a short run deadline gives a partial, neutral review", async () => {
  for (const bad of [["--run-timeout", "soon"], ["--step-timeout", "judge=5m"], ["--idle-timeout", "reviewer=0"]]) {
    const cap = io();
    assert.equal(await main(["review", "--dry-run", "--fixture", FIXTURE, ...bad], cap.io), 2, bad.join(" "));
  }
  const cap = io();
  const code = await main(
    [
      "review",
      "--dry-run",
      "--fixture",
      FIXTURE,
      "--script",
      join(FIXTURE, "script.json"),
      "--no-modcache",
      "--runs-dir",
      join(work, "runs"),
      "--step-timeout",
      "20m",
      "--idle-timeout",
      "verifier=2m",
      "--run-timeout",
      "1ms",
      "--quiet",
    ],
    cap.io,
  );
  assert.equal(code, 1);
  const payload = JSON.parse(cap.out.stdout) as { check_run: { conclusion: string; output: { summary: string } } };
  assert.equal(payload.check_run.conclusion, "neutral");
  assert.match(payload.check_run.output.summary, /run deadline of 1 ms was reached/);
});

test("--head and --as-of: only with --pr, a SHA and a time", async () => {
  const cases: Array<[string[], RegExp]> = [
    [["--fixture", FIXTURE, "--head", "abc1234"], /--head and --as-of need --pr/],
    [["--pr", "o/r#1", "--head", "main"], /invalid --head main/],
    [["--pr", "o/r#1", "--as-of", "2024-01-01T00:00:00Z"], /--as-of needs --head/],
    [["--pr", "o/r#1", "--head", "abc1234", "--as-of", "yesterday"], /invalid --as-of/],
  ];
  for (const [extra, message] of cases) {
    const cap = io();
    assert.equal(await main(["review", "--dry-run", ...extra], cap.io), 2, extra.join(" "));
    assert.match(cap.out.stderr, message);
  }
});

test("malformed --acp-agent and --acp-config are usage errors", async () => {
  const bad = io();
  assert.equal(await main(["review", "--dry-run", "--fixture", FIXTURE, "--acp-agent", "=node"], bad.io), 2);
  assert.match(bad.out.stderr, /--acp-agent must be <name>=<command>/);
  const missing = io();
  assert.equal(await main(["review", "--dry-run", "--fixture", FIXTURE, "--acp-config", join(work, "none.json")], missing.io), 2);
  assert.match(missing.out.stderr, /cannot read --acp-config/);
});

test("--waiting: the gate's JSON line is checked against the record schema (A-6)", async () => {
  const { parseWaiting } = await import("./main.ts");
  assert.deepEqual(parseWaiting('{"headSeenAt":"2026-11-20T09:00:00Z","ci":"passed","required":["build"]}'), { headSeenAt: "2026-11-20T09:00:00Z", ci: "passed", required: ["build"] });
  for (const bad of ["nope", '{"ci":"passed"}', '{"headSeenAt":"yesterday","ci":"passed"}', '{"headSeenAt":"2026-11-20T09:00:00Z","ci":"maybe"}', '{"headSeenAt":"2026-11-20T09:00:00Z","ci":"failed","failed":["a\\nb"]}', '{"headSeenAt":"2026-11-20T09:00:00Z","ci":"passed","extra":1}']) {
    assert.throws(() => parseWaiting(bad), /--waiting/, bad);
  }
});

test("--agent-dir (F-7): settings reach the run; a broken settings.json is a configuration error, not 'no configuration'", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const dir = join(work, "agent");
  mkdirSync(dir);
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ reviewBot: { roles: { reviewer: { tools: ["+fixture_lookup"] } } } }));
  const base = ["review", "--dry-run", "--fixture", FIXTURE, "--script", join(FIXTURE, "script.json"), "--no-modcache", "--runs-dir", join(work, "runs"), "--quiet"];
  const cap = io();
  assert.equal(await main([...base, "--agent-dir", dir], cap.io), 1);
  assert.match(cap.out.stdout, /tools in settings\.json names fixture_lookup, but no packages are listed/);

  writeFileSync(join(dir, "settings.json"), '{"reviewBot": ');
  const broken = io();
  assert.equal(await main([...base, "--agent-dir", dir], broken.io), 1);
  assert.match(broken.out.stderr, /configuration error: .*settings\.json is not valid JSON/);
  assert.equal(broken.out.stdout, "", "nothing ran");
  const missing = io();
  assert.equal(await main([...base, "--agent-dir", join(work, "no-such-dir")], missing.io), 1);
  assert.match(missing.out.stderr, /cannot read/);
});

test("pi's thinking levels, the run-timeout ceiling, and help text that no longer says the YAML overrides", async () => {
  const base = ["review", "--dry-run", "--fixture", FIXTURE, "--script", join(FIXTURE, "script.json"), "--no-modcache", "--runs-dir", join(work, "runs"), "--quiet"];
  const ok = io();
  assert.equal(await main([...base, "--thinking", "reviewer=xhigh", "--thinking", "verifier=max", "--max-run-timeout", "30m"], ok.io), 0, ok.out.stderr);
  const bad = io();
  assert.equal(await main([...base, "--thinking", "reviewer=ultra"], bad.io), 2);
  assert.match(bad.out.stderr, /invalid thinking level: ultra \(use off, minimal, low, medium, high, xhigh, max\)/);
  assert.equal(await main([...base, "--max-run-timeout", "soon"], io().io), 2);
  const help = io();
  assert.equal(await main(["--help"], help.io), 0);
  assert.doesNotMatch(help.out.stdout, /overrides? (it|them|the)\b|review-bot\.yaml[^\n]*overrides/);
  assert.match(help.out.stdout, /--agent-dir <dir>/);
  assert.match(help.out.stdout, /can only\s+narrow/);
});
