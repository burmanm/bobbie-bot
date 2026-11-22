/** H-51: check names and reasons from the PR are inert in check runs and step summaries. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCi } from "../cli/ci.ts";
import { assertInert, assertNoCommandLines } from "../core/markdown-testing.ts";
import { Github } from "./github.ts";
import { fakeGithub, SHA_A, SHA_B } from "./testing.ts";

test("every check-run write neutralizes its summary", async () => {
  const sent: string[] = [];
  const gh = new Github({
    token: "t",
    repo: "o/r",
    fetch: async (_url, init) => {
      if (init.body !== undefined) sent.push((JSON.parse(init.body) as { output: { summary: string } }).output.summary);
      return { status: 200, headers: { get: () => null }, text: async () => '{"id":1}' };
    },
  });
  const output = { title: "Skipped: CI failed", summary: "CI failed: build ![x](https://evil.example/p?q=1) @org/team\n/approve" };
  await gh.createCompletedCheck("ai-review/main", "a".repeat(40), "skipped", output);
  await gh.createQueuedCheck("ai-review/main", "a".repeat(40), output, "2026-11-22T00:00:00Z");
  await gh.updateCheck(1, "queued", output);
  await gh.completeCheck(1, "skipped", output);
  assert.equal(sent.length, 4);
  for (const s of sent) {
    assertInert(s);
    assertNoCommandLines(s);
  }
});

test("the gate's step summary neutralizes its reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "review-bot-summary-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const event = join(dir, "event.json");
  const summary = join(dir, "summary.md");
  const pull = { number: 7, state: "open", draft: false, user: { login: "dev", type: "User" }, labels: [], head: { sha: SHA_A }, base: { sha: SHA_B, ref: "main" } };
  writeFileSync(event, JSON.stringify({ action: "opened", pull_request: pull, sender: { login: "dev" } }));
  const { fetch } = fakeGithub({ pulls: { 7: { number: 7, user: { login: "dev" }, labels: [], head: SHA_A, base: SHA_B } }, roles: { dev: "write" } });
  const code = await runCi(
    "gate",
    ["--repo", "o/r", "--event-name", "pull_request_target", "--event-path", event, "--ci-require", "build ![x](https://evil.example/p?q=1)"],
    { stdout: () => {}, stderr: () => {} },
    { env: { GH_TOKEN: "t", GITHUB_STEP_SUMMARY: summary }, fetch },
  );
  assert.equal(code, 0);
  const text = readFileSync(summary, "utf8");
  assert.match(text, /evil\.example/, "the reason carries the check name");
  assertInert(text);
});
