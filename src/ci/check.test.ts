/** The always-run check completion (S-9). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { completeIfUnfinished } from "./check.ts";
import { Github } from "./github.ts";
import { fakeGithub, type FakeRepo, SHA_A } from "./testing.ts";

const NAME = "ai-review/main";

function setup(checks: NonNullable<FakeRepo["checks"]>, foreignChecks: number[] = []) {
  const r: FakeRepo = { pulls: {}, roles: {}, checks, foreignChecks };
  const gh = fakeGithub(r);
  return { r, gh, client: new Github({ token: "t", repo: "o/r", fetch: gh.fetch }) };
}

test("an in-progress check is completed as neutral", async () => {
  const { r, client } = setup([{ id: 1, name: NAME, head_sha: SHA_A, status: "in_progress", conclusion: null }]);
  assert.equal(await completeIfUnfinished(client, "main", SHA_A, "cancelled", () => {}), "completed");
  assert.deepEqual([r.checks![0]!.status, r.checks![0]!.conclusion], ["completed", "neutral"]);
});

test("a completed check is left alone", async () => {
  const { gh, client } = setup([{ id: 1, name: NAME, head_sha: SHA_A, status: "completed", conclusion: "success" }]);
  assert.equal(await completeIfUnfinished(client, "main", SHA_A, "success", () => {}), "none");
  assert.ok(!gh.calls.some((c) => c.method !== "GET"));
});

test("no check yet (the job died before intake) → a completed neutral one is created", async () => {
  const { r, client } = setup([]);
  assert.equal(await completeIfUnfinished(client, "main", SHA_A, "skipped", () => {}), "created");
  assert.equal(r.checks![0]!.conclusion, "neutral");
  assert.equal(r.checks![0]!.name, NAME);
});

test("a check owned by another identity → a new completed one is created", async () => {
  const { r, client } = setup([{ id: 1, name: NAME, head_sha: SHA_A, status: "queued", conclusion: null }], [1]);
  assert.equal(await completeIfUnfinished(client, "main", SHA_A, "failure", () => {}), "created");
  assert.equal(r.checks![0]!.status, "completed");
});
