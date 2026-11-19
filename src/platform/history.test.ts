/**
 * History source over `gh` (S-4) and the replay reader (E-2). `gh` is
 * replaced by a recorder: no network (AGENTS.md).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HistoryNotFound } from "../core/index.ts";
import type { PrReader } from "./dry-run.ts";
import { FakeHistory } from "./history-fake.ts";
import { GhError, GhHistory, type GhRunner } from "./history-github.ts";
import { AtHeadReader } from "./history-head.ts";
import type { PrComment, PullRequestInfo } from "./types.ts";

const SHA = "a".repeat(40);
const OLD = "b".repeat(40);
const BASE = "c".repeat(40);
const MB = "d".repeat(40);

function recorder(answers: Array<string | Error>): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push([...args]);
    const a = answers.shift();
    if (a === undefined) throw new Error("unexpected gh call");
    if (a instanceof Error) throw a;
    return a;
  };
  return { gh, calls };
}

const ghCommit = (sha: string, msg: string, extra: object = {}) => ({
  sha,
  commit: { message: msg, author: { name: "Ann", date: "2024-05-01T10:00:00Z" }, committer: { date: "2024-05-02T10:00:00Z" } },
  parents: [{ sha: OLD }],
  ...extra,
});

describe("GhHistory (S-4: history through the GitHub API, read-only)", () => {
  test("log: GET only, scoped to the repository, path encoded, limit and until passed", async () => {
    const r = recorder([JSON.stringify([ghCommit(SHA, "fix: guard nil\n\nlong body")])]);
    const h = new GhHistory("o/r", r.gh);
    const list = await h.log({ sha: SHA, path: "pkg/a b.go", limit: 5, until: "2024-06-01T00:00:00Z" });
    assert.deepEqual(list, [{ sha: SHA, date: "2024-05-01T10:00:00Z", author: "Ann", headline: "fix: guard nil" }]);
    assert.deepEqual(r.calls[0]!.slice(0, 3), ["api", "--method", "GET"]);
    assert.equal(r.calls[0]!.at(-1), `repos/o/r/commits?sha=${SHA}&per_page=5&path=pkg%2Fa%20b.go&until=2024-06-01T00%3A00%3A00Z`);
  });

  test("bad SHAs, paths and repositories are refused before any call", async () => {
    const r = recorder([]);
    const h = new GhHistory("o/r", r.gh);
    await assert.rejects(h.log({ sha: "HEAD~1", limit: 1 }), /invalid commit SHA/);
    await assert.rejects(h.log({ sha: SHA, path: "../etc/passwd", limit: 1 }), /'\.\.'/);
    await assert.rejects(h.commit({ sha: SHA, path: "/abs" }), /relative/);
    await assert.rejects(h.blame({ sha: "abc1234", path: "a.go", startLine: 1, endLine: 2 }), /full commit SHA/);
    assert.throws(() => new GhHistory("o/r/../x", r.gh), /invalid repository/);
    assert.equal(r.calls.length, 0);
  });

  test("blame: one read-only GraphQL query, ranges clipped to the requested lines", async () => {
    const data = {
      data: {
        repository: {
          object: {
            blame: {
              ranges: [
                { startingLine: 1, endingLine: 9, commit: { oid: OLD, authoredDate: "2023-01-01T00:00:00Z", messageHeadline: "init", author: { name: "Bo" } } },
                { startingLine: 10, endingLine: 20, commit: { oid: SHA, authoredDate: "2024-01-01T00:00:00Z", messageHeadline: "change", author: { name: "Cy" } } },
                { startingLine: 21, endingLine: 30, commit: { oid: OLD, authoredDate: "2023-01-01T00:00:00Z", messageHeadline: "init", author: { name: "Bo" } } },
              ],
            },
          },
        },
      },
    };
    const r = recorder([JSON.stringify(data)]);
    const ranges = await new GhHistory("o/r", r.gh).blame({ sha: SHA, path: "a.go", startLine: 5, endLine: 12 });
    assert.deepEqual(
      ranges.map((x) => [x.startLine, x.endLine, x.commit.author]),
      [
        [5, 9, "Bo"],
        [10, 12, "Cy"],
      ],
    );
    assert.equal(r.calls[0]![1], "graphql");
    assert.match(r.calls[0]![3]!, /^query=query\(/);
    assert.ok(!r.calls[0]!.join(" ").includes("mutation"));
    assert.ok(r.calls[0]!.includes(`oid=${SHA}`));
  });

  test("commit: message, files and patch; filtered to one path; committer date kept", async () => {
    const files = [
      { filename: "a.go", status: "modified", additions: 1, deletions: 2, patch: "@@ -1 +1 @@" },
      { filename: "b.go", previous_filename: "old.go", status: "renamed", additions: 0, deletions: 0 },
    ];
    const r = recorder([JSON.stringify(ghCommit(SHA, "msg", { files })), JSON.stringify(ghCommit(SHA, "msg", { files }))]);
    const h = new GhHistory("o/r", r.gh);
    const all = await h.commit({ sha: SHA });
    assert.equal(all.files.length, 2);
    assert.equal(all.committedAt, "2024-05-02T10:00:00Z");
    assert.deepEqual(all.parents, [OLD]);
    const one = await h.commit({ sha: SHA, path: "old.go" });
    assert.deepEqual(one.files.map((f) => f.path), ["b.go"]);
  });

  test("issue search: always repo-scoped and issues only; qualifier words never reach the query; PRs dropped", async () => {
    const items = [
      { number: 7, title: "Leak", state: "open", labels: [{ name: "tech-debt" }], html_url: "https://github.com/o/r/issues/7", created_at: "2024-01-01T00:00:00Z", body: "x" },
      { number: 8, title: "PR", state: "open", html_url: "u", created_at: "2024-01-01T00:00:00Z", pull_request: {} },
    ];
    const r = recorder([JSON.stringify({ items })]);
    const found = await new GhHistory("o/r", r.gh).searchIssues({
      words: ["leak", "repo:evil/x"],
      state: "open",
      label: "tech-debt",
      limit: 5,
      createdBefore: "2024-03-01T00:00:00.000Z",
    });
    assert.deepEqual(found.map((i) => i.number), [7]);
    const url = r.calls[0]!.at(-1)!;
    const q = decodeURIComponent(/q=([^&]*)/.exec(url)![1]!);
    assert.equal(q, 'repo:o/r is:issue state:open label:"tech-debt" created:<=2024-03-01T00:00:00 leak');
  });

  test("404 becomes HistoryNotFound; other errors pass through", async () => {
    const r = recorder([new GhError("gh: Not Found (HTTP 404)"), new GhError("HTTP 502")]);
    const h = new GhHistory("o/r", r.gh);
    await assert.rejects(h.commit({ sha: SHA }), HistoryNotFound);
    await assert.rejects(h.commit({ sha: SHA }), (e: unknown) => e instanceof GhError);
  });
});

describe("AtHeadReader (E-2 replay at an earlier head)", () => {
  const pr: PullRequestInfo = {
    repo: "o/r",
    number: 5,
    title: "t",
    body: "b",
    author: { login: "dev", type: "User" },
    labels: [],
    draft: false,
    baseSha: BASE,
    headSha: SHA,
  };
  const comments: PrComment[] = [
    { id: "1", kind: "review-comment", author: { login: "x", type: "User" }, body: "on old head", path: "a.go", line: 40, createdAt: "2024-05-02T11:00:00Z", threadResolved: true },
    { id: "2", kind: "review-comment", author: { login: "x", type: "User" }, body: "earlier commit", path: "a.go", line: 41, createdAt: "2024-05-01T09:00:00Z" },
    { id: "3", kind: "issue-comment", author: { login: "y", type: "User" }, body: "found the bug", createdAt: "2024-05-03T00:00:00Z" },
    { id: "4", kind: "issue-comment", author: { login: "y", type: "User" }, body: "no time" },
  ];
  const inner: PrReader = {
    kind: "test",
    getPullRequest: async () => pr,
    getDiff: async () => "today's diff",
    listComments: async () => comments,
  };
  const fake = () =>
    new FakeHistory("o/r", {
      commits: { [OLD]: { sha: OLD, date: "2024-05-02T09:00:00Z", committedAt: "2024-05-02T12:00:00Z", author: "a", headline: "h", message: "h", parents: [], files: [] } },
      mergeBases: { [`${BASE}...${OLD}`]: MB },
      diffs: { [`${MB}...${OLD}`]: "old diff" },
      pullCommits: [OLD, SHA],
      origins: { "1": { commitId: OLD, line: 12, startLine: 10 }, "2": { commitId: MB, line: 3 } },
    });

  test("head is the given commit, base its merge base with the PR base; the diff is base...head", async () => {
    const reader = new AtHeadReader(inner, fake(), OLD.slice(0, 10));
    const p = await reader.getPullRequest();
    assert.equal(p.headSha, OLD);
    assert.equal(p.baseSha, MB);
    assert.equal(await reader.getDiff(), "old diff");
    assert.equal(reader.cutoff, "2024-05-02T12:00:00Z");
    assert.equal(reader.info?.inPrCommits, true);
    assert.equal(reader.info?.currentHeadSha, SHA);
  });

  test("comments after the cutoff are left out; lines come from the comment's own commit or are cleared; resolution dropped", async () => {
    const reader = new AtHeadReader(inner, fake(), OLD);
    const got = await reader.listComments();
    assert.deepEqual(got.map((c) => c.id), ["1", "2", "4"]);
    const [c1, c2] = got;
    assert.equal(c1!.line, 12);
    assert.equal(c1!.startLine, 10);
    assert.equal(c1!.threadResolved, undefined);
    assert.equal(c2!.line, undefined, "made on another commit: its line at this head is unknown");
    assert.deepEqual(reader.info?.comments, { kept: 3, dropped: 1, lineFromOriginal: 1, lineCleared: 1, undated: 1 });
  });

  test("an explicit cutoff wins; invalid SHAs and times are refused", async () => {
    const reader = new AtHeadReader(inner, fake(), OLD, { asOf: "2024-05-01T12:00:00Z" });
    const got = await reader.listComments();
    assert.deepEqual(got.map((c) => c.id), ["2", "4"]);
    assert.throws(() => new AtHeadReader(inner, fake(), "main"), /invalid head SHA/);
    assert.throws(() => new AtHeadReader(inner, fake(), OLD, { asOf: "yesterday" }), /invalid time/);
  });

  test("an unknown SHA fails reading the PR", async () => {
    const reader = new AtHeadReader(inner, fake(), "e".repeat(40));
    await assert.rejects(reader.getPullRequest(), HistoryNotFound);
  });
});
