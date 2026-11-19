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

test("without a model the run completes neutral instead of picking one (P-4)", async () => {
  const cap = io();
  const code = await main(["review", "--dry-run", "--fixture", FIXTURE, "--no-modcache", "--runs-dir", join(work, "runs"), "--quiet"], cap.io);
  assert.equal(code, 1);
  const payload = JSON.parse(cap.out.stdout) as { check_run: { conclusion: string; output: { summary: string } } };
  assert.equal(payload.check_run.conclusion, "neutral");
  assert.match(payload.check_run.output.summary, /no model is configured for the reviewer role/);
});

test("malformed --acp-agent and --acp-config are usage errors", async () => {
  const bad = io();
  assert.equal(await main(["review", "--dry-run", "--fixture", FIXTURE, "--acp-agent", "=node"], bad.io), 2);
  assert.match(bad.out.stderr, /--acp-agent must be <name>=<command>/);
  const missing = io();
  assert.equal(await main(["review", "--dry-run", "--fixture", FIXTURE, "--acp-config", join(work, "none.json")], missing.io), 2);
  assert.match(missing.out.stderr, /cannot read --acp-config/);
});
