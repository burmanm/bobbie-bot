/** Platform pieces without network: isolation check, gh reader against a fake exec, dry-run recording. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { DryRunPlatform } from "./dry-run.ts";
import { GhPrReader, parsePrRef } from "./github-read.ts";
import { assertIsolatedLocation, type Exec } from "./snapshot.ts";

const work = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-platform-")));
after(() => rmSync(work, { recursive: true, force: true }));

describe("snapshot location (C-3a)", () => {
  test("refuses a directory with .git or a context file above it", () => {
    for (const name of [".git", "AGENTS.md", "CLAUDE.md"]) {
      const parent = mkdtempSync(join(work, "loc-"));
      writeFileSync(join(parent, name), "x");
      const runs = join(parent, "runs", "deeper");
      mkdirSync(runs, { recursive: true });
      assert.throws(() => assertIsolatedLocation(runs), new RegExp(`${name.replace(".", "\\.")} exists`));
    }
    const clean = mkdtempSync(join(work, "clean-"));
    assert.doesNotThrow(() => assertIsolatedLocation(clean));
  });
});

describe("GitHub reader (read-only through gh)", () => {
  test("PR references", () => {
    assert.deepEqual(parsePrRef("k8ssandra/cass-operator#1021"), { repo: "k8ssandra/cass-operator", number: 1021 });
    assert.deepEqual(parsePrRef("https://github.com/k8ssandra/cass-operator/pull/1021"), { repo: "k8ssandra/cass-operator", number: 1021 });
    assert.equal(parsePrRef("cass-operator 1021"), undefined);
  });

  test("only GET requests and one GraphQL query; comments normalized with resolution state", async () => {
    const seen: string[][] = [];
    const exec: Exec = async (file, args) => {
      assert.equal(file, "gh");
      seen.push([...args]);
      const path = args[args.length - 1]!;
      let out: unknown;
      if (args[1] === "graphql") {
        out = { data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: true, comments: { nodes: [{ databaseId: 11 }] } }] } } } } };
        return { stdout: Buffer.from(JSON.stringify(out)) };
      }
      const lines = (xs: unknown[]) => ({ stdout: Buffer.from(xs.map((x) => JSON.stringify(x)).join("\n") + "\n") });
      if (path.endsWith("/pulls/7/comments")) {
        return lines([
          { id: 11, user: { login: "bot[bot]", type: "Bot" }, body: "b", path: "a.go", line: 3, created_at: "t" },
          { id: 12, user: { login: "dev", type: "User" }, body: "r", path: "a.go", line: null, in_reply_to_id: 11 },
        ]);
      }
      if (path.endsWith("/issues/7/comments")) return lines([{ id: 21, user: { login: "dev", type: "User" }, body: "hi" }]);
      if (path.endsWith("/pulls/7/reviews")) return lines([{ id: 31, user: { login: "x", type: "User" }, body: "" }, { id: 32, user: { login: "bot[bot]", type: "Bot" }, body: "summary" }]);
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    const comments = await new GhPrReader("o/r", 7, exec).listComments();
    assert.deepEqual(
      comments.map((c) => [c.id, c.kind, c.author.type, c.line ?? null, c.inReplyTo ?? null, c.threadResolved ?? null]),
      [
        ["11", "review-comment", "Bot", 3, null, true],
        ["12", "review-comment", "User", null, "11", null],
        ["21", "issue-comment", "User", null, null, null],
        ["32", "review", "Bot", null, null, null],
      ],
    );
    for (const args of seen) {
      if (args[1] === "graphql") assert.ok(args.some((a) => a.startsWith("query=query(")), "a query, never a mutation");
      else assert.deepEqual(args.slice(0, 3), ["api", "--method", "GET"]);
    }
  });

  test("a dry run counts only reviews recorded on this reviewer's check run (D-5, H-50)", async () => {
    const sha = "a".repeat(40);
    const body = `<!-- review-bot:summary bot=ai-review/security run=r1 sha=${sha} fpv=1 -->`;
    const user = { login: "github-actions[bot]", type: "Bot" };
    const paths: string[] = [];
    const reader = (readable: boolean) => {
      const exec: Exec = async (_file, args) => {
        const path = args[args.length - 1]!;
        paths.push(path);
        let rows: unknown[] = [];
        if (args[1] === "graphql") return { stdout: Buffer.from("{}") };
        if (path.endsWith("/pulls/7/reviews")) rows = [{ id: 31, user, body, commit_id: sha }, { id: 32, user, body, commit_id: sha }];
        if (path.endsWith("/pulls/7/comments")) rows = [{ id: 11, user, body: "f", pull_request_review_id: 31 }, { id: 12, user, body: "f", pull_request_review_id: 32 }];
        if (path.includes("/check-runs?")) {
          if (!readable) throw new Error("403");
          rows = [{ external_id: "review-bot:review=31", app: { slug: "github-actions" } }];
        }
        return { stdout: Buffer.from(rows.map((x) => JSON.stringify(x)).join("\n")) };
      };
      return new GhPrReader("o/r", 7, exec, "ai-review/security");
    };
    const own = async (readable: boolean) => (await reader(readable).listComments()).filter((c) => c.recordedBy !== undefined).map((c) => c.id);
    assert.deepEqual(await own(true), ["11", "31"]);
    assert.ok(paths.includes(`repos/o/r/commits/${sha}/check-runs?check_name=ai-review%2Fsecurity&filter=all&per_page=100`));
    assert.deepEqual(await own(false), [], "unreadable: nothing is trusted");
  });
});

describe("dry-run platform", () => {
  test("records one publication and one check completion, and refuses a second of either", async () => {
    const p = new DryRunPlatform({
      kind: "test",
      getPullRequest: async () => ({ repo: "o/r", number: 1, title: "", body: "", author: { login: "a", type: "User" }, labels: [], draft: false, baseSha: "a", headSha: "b" }),
      getDiff: async () => "",
      listComments: async () => [],
    });
    await p.getPullRequest();
    await p.startCheck("ai-review/main", "b");
    assert.equal(p.output.check_run?.status, "in_progress");
    await p.publish({ threadReplies: [{ in_reply_to: 1, body: "x" }], resolveThreads: [] });
    await assert.rejects(p.publish({ threadReplies: [], resolveThreads: [] }), /published twice/);
    await p.completeCheck({ name: "ai-review/main", headSha: "b", conclusion: "success", title: "Reviewed", summary: "ok" });
    await assert.rejects(p.completeCheck({ name: "ai-review/main", headSha: "b", conclusion: "success", title: "", summary: "" }), /completed twice/);
    assert.deepEqual(p.output.check_run, { name: "ai-review/main", head_sha: "b", status: "completed", conclusion: "success", output: { title: "Reviewed", summary: "ok" } });
    assert.equal(p.output.repo, "o/r");
  });
});
