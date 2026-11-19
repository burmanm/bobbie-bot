/**
 * Repository history through the GitHub API (S-4: "read-only history
 * queries served by the orchestrator through the GitHub API — there is no
 * `.git`"), and the extra reads a replay at an earlier head needs (E-2).
 *
 * Calls go through `gh`, which supplies its own authentication (`GH_TOKEN`
 * in CI, the user's login locally); this module never sees the token, and
 * the model only ever sees the formatted answers. Only GET requests and
 * read-only GraphQL queries. Every call is scoped to `repo`, takes an abort
 * signal, and kills `gh` when it fires.
 */
import { execFile } from "node:child_process";
import {
  type BlameQuery,
  type BlameRange,
  type CommitDetail,
  type CommitQuery,
  type CommitSummary,
  FULL_SHA_RE,
  HistoryNotFound,
  type HistorySource,
  type IssueQuery,
  type IssueSummary,
  type LogQuery,
  repoPathProblem,
  SHA_RE,
} from "../core/index.ts";
import type { ReplaySource, ReviewCommentOrigin } from "./history-head.ts";

/** Runs `gh` with arguments; stdout as text. Injected in tests. */
export type GhRunner = (args: readonly string[], signal?: AbortSignal) => Promise<string>;

const MAX_OUTPUT = 64 * 1024 * 1024;

export const defaultGhRunner: GhRunner = (args, signal) =>
  new Promise((resolvePromise, reject) => {
    execFile(
      "gh",
      [...args],
      { encoding: "utf8", maxBuffer: MAX_OUTPUT, ...(signal === undefined ? {} : { signal }) },
      (error, stdout, stderr) => {
        if (error) {
          const detail = typeof stderr === "string" ? stderr.trim().split("\n").slice(-3).join(" ") : "";
          reject(new GhError(detail || error.message));
        } else {
          resolvePromise(stdout);
        }
      },
    );
  });

export class GhError extends Error {
  override name = "GhError";
  get notFound(): boolean {
    return /\b(404|Not Found|422|No commit found|Could not resolve)\b/i.test(this.message);
  }
}

interface GhCommit {
  sha: string;
  commit: { message?: string; author?: { name?: string; date?: string } | null; committer?: { date?: string } | null };
  author?: { login?: string } | null;
  parents?: Array<{ sha: string }>;
  files?: Array<{
    filename: string;
    previous_filename?: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>;
}

function summary(c: GhCommit): CommitSummary {
  const message = c.commit.message ?? "";
  return {
    sha: c.sha,
    date: c.commit.author?.date ?? "",
    author: c.commit.author?.name ?? c.author?.login ?? "unknown",
    headline: message.split("\n")[0] ?? "",
  };
}

const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const enc = encodeURIComponent;

export class GhHistory implements HistorySource, ReplaySource {
  readonly repo: string;
  private readonly gh: GhRunner;

  constructor(repo: string, gh: GhRunner = defaultGhRunner) {
    if (!REPO_RE.test(repo)) throw new Error(`invalid repository: ${repo}`);
    this.repo = repo;
    this.gh = gh;
  }

  private async get<T>(path: string, signal?: AbortSignal, extra: string[] = []): Promise<T> {
    try {
      return JSON.parse(await this.gh(["api", "--method", "GET", ...extra, path], signal)) as T;
    } catch (e) {
      if (e instanceof GhError && e.notFound) throw new HistoryNotFound(`not found: ${path.split("?")[0]}`);
      throw e;
    }
  }

  private async graphql<T>(query: string, vars: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [k, v] of Object.entries(vars)) args.push("-f", `${k}=${v}`);
    const out = JSON.parse(await this.gh(args, signal)) as { data?: T; errors?: Array<{ message?: string }> };
    if (out.errors?.length) throw new HistoryNotFound(out.errors.map((e) => e.message ?? "error").join("; "));
    if (out.data === undefined) throw new Error("GraphQL returned no data");
    return out.data;
  }

  private checkSha(sha: string): void {
    if (!SHA_RE.test(sha)) throw new Error(`invalid commit SHA: ${sha}`);
  }

  private checkPath(path: string): void {
    const p = repoPathProblem(path);
    if (p !== undefined) throw new Error(p);
  }

  async log(q: LogQuery, signal?: AbortSignal): Promise<CommitSummary[]> {
    this.checkSha(q.sha);
    if (q.path !== undefined) this.checkPath(q.path);
    const params = [`sha=${q.sha}`, `per_page=${Math.max(1, Math.min(100, q.limit))}`];
    if (q.path !== undefined) params.push(`path=${enc(q.path)}`);
    if (q.until !== undefined) params.push(`until=${enc(q.until)}`);
    const list = await this.get<GhCommit[]>(`repos/${this.repo}/commits?${params.join("&")}`, signal);
    return list.slice(0, q.limit).map(summary);
  }

  async blame(q: BlameQuery, signal?: AbortSignal): Promise<BlameRange[]> {
    if (!FULL_SHA_RE.test(q.sha)) throw new Error(`blame needs a full commit SHA: ${q.sha}`);
    this.checkPath(q.path);
    const [owner, name] = this.repo.split("/") as [string, string];
    const query = `query($owner:String!,$name:String!,$oid:GitObjectID!,$path:String!){repository(owner:$owner,name:$name){object(oid:$oid){... on Commit{blame(path:$path){ranges{startingLine endingLine commit{oid authoredDate messageHeadline author{name user{login}}}}}}}}}`;
    type Range = {
      startingLine: number;
      endingLine: number;
      commit: { oid: string; authoredDate: string; messageHeadline: string; author?: { name?: string; user?: { login?: string } | null } | null };
    };
    const data = await this.graphql<{ repository?: { object?: { blame?: { ranges: Range[] } } | null } | null }>(
      query,
      { owner, name, oid: q.sha, path: q.path },
      signal,
    );
    const ranges = data.repository?.object?.blame?.ranges;
    if (ranges === undefined) throw new HistoryNotFound(`no blame for ${q.path} at ${q.sha.slice(0, 7)}`);
    return ranges
      .filter((r) => r.endingLine >= q.startLine && r.startingLine <= q.endLine)
      .map((r) => ({
        startLine: Math.max(r.startingLine, q.startLine),
        endLine: Math.min(r.endingLine, q.endLine),
        commit: {
          sha: r.commit.oid,
          date: r.commit.authoredDate,
          author: r.commit.author?.name ?? r.commit.author?.user?.login ?? "unknown",
          headline: r.commit.messageHeadline,
        },
      }));
  }

  async commit(q: CommitQuery, signal?: AbortSignal): Promise<CommitDetail> {
    this.checkSha(q.sha);
    if (q.path !== undefined) this.checkPath(q.path);
    const c = await this.get<GhCommit>(`repos/${this.repo}/commits/${q.sha}`, signal);
    const files = (c.files ?? [])
      .filter((f) => q.path === undefined || f.filename === q.path || f.previous_filename === q.path)
      .map((f) => ({
        path: f.filename,
        ...(f.previous_filename === undefined ? {} : { previousPath: f.previous_filename }),
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        ...(f.patch === undefined ? {} : { patch: f.patch }),
      }));
    const detail: CommitDetail = {
      ...summary(c),
      ...(c.commit.committer?.date === undefined ? {} : { committedAt: c.commit.committer.date }),
      message: c.commit.message ?? "",
      parents: (c.parents ?? []).map((p) => p.sha),
      files,
    };
    // The REST endpoint returns at most 300 files per page.
    if ((c.files ?? []).length >= 300) detail.filesTruncated = true;
    return detail;
  }

  async searchIssues(q: IssueQuery, signal?: AbortSignal): Promise<IssueSummary[]> {
    const terms = [`repo:${this.repo}`, "is:issue"];
    if (q.state !== "all") terms.push(`state:${q.state}`);
    if (q.label !== undefined) {
      if (!/^[^"\n\r]{1,50}$/.test(q.label)) throw new Error(`invalid label: ${q.label}`);
      terms.push(`label:"${q.label}"`);
    }
    if (q.createdBefore !== undefined) terms.push(`created:<=${q.createdBefore.slice(0, 19)}`);
    // Words are checked by the caller (searchWords); qualifiers would be re-added here otherwise.
    for (const w of q.words) if (!w.includes(":")) terms.push(w);
    const params = `q=${enc(terms.join(" "))}&per_page=${Math.max(1, Math.min(50, q.limit))}`;
    type Item = {
      number: number;
      title: string;
      state: string;
      labels?: Array<{ name?: string }>;
      html_url: string;
      created_at: string;
      body?: string | null;
      pull_request?: unknown;
    };
    const out = await this.get<{ items?: Item[] }>(`search/issues?${params}`, signal);
    return (out.items ?? [])
      .filter((i) => i.pull_request === undefined)
      .slice(0, q.limit)
      .map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state === "closed" ? "closed" : "open",
        labels: (i.labels ?? []).map((l) => l.name ?? "").filter((n) => n !== ""),
        url: i.html_url,
        createdAt: i.created_at,
        excerpt: (i.body ?? "").slice(0, 400),
      }));
  }

  // ---- ReplaySource (E-2) -------------------------------------------------

  async compareDiff(baseSha: string, headSha: string, signal?: AbortSignal): Promise<string> {
    this.checkSha(baseSha);
    this.checkSha(headSha);
    return this.gh(["api", "--method", "GET", "-H", "Accept: application/vnd.github.v3.diff", `repos/${this.repo}/compare/${baseSha}...${headSha}`], signal);
  }

  async mergeBase(baseSha: string, headSha: string, signal?: AbortSignal): Promise<string> {
    this.checkSha(baseSha);
    this.checkSha(headSha);
    const c = await this.get<{ merge_base_commit?: { sha?: string } }>(`repos/${this.repo}/compare/${baseSha}...${headSha}`, signal, [
      "--jq",
      "{merge_base_commit: {sha: .merge_base_commit.sha}}",
    ]);
    const sha = c.merge_base_commit?.sha;
    if (sha === undefined || !FULL_SHA_RE.test(sha)) throw new HistoryNotFound(`no merge base for ${baseSha.slice(0, 7)}...${headSha.slice(0, 7)}`);
    return sha;
  }

  async resolveCommit(sha: string, signal?: AbortSignal): Promise<{ sha: string; committedAt: string }> {
    this.checkSha(sha);
    const c = await this.get<{ sha: string; date?: string }>(`repos/${this.repo}/commits/${sha}`, signal, [
      "--jq",
      "{sha: .sha, date: .commit.committer.date}",
    ]);
    return { sha: c.sha, committedAt: c.date ?? "" };
  }

  async pullCommits(prNumber: number, signal?: AbortSignal): Promise<string[]> {
    const text = await this.gh(["api", "--method", "GET", "--paginate", "--jq", ".[].sha", `repos/${this.repo}/pulls/${prNumber}/commits`], signal);
    return text.split("\n").filter((l) => FULL_SHA_RE.test(l.trim())).map((l) => l.trim());
  }

  async reviewCommentOrigins(prNumber: number, signal?: AbortSignal): Promise<Map<string, ReviewCommentOrigin>> {
    const text = await this.gh(
      [
        "api",
        "--method",
        "GET",
        "--paginate",
        "--jq",
        ".[] | {id, original_commit_id, original_line, original_start_line}",
        `repos/${this.repo}/pulls/${prNumber}/comments`,
      ],
      signal,
    );
    const map = new Map<string, ReviewCommentOrigin>();
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const r = JSON.parse(line) as { id: number; original_commit_id?: string; original_line?: number | null; original_start_line?: number | null };
      const o: ReviewCommentOrigin = { commitId: r.original_commit_id ?? "" };
      if (typeof r.original_line === "number") o.line = r.original_line;
      if (typeof r.original_start_line === "number") o.startLine = r.original_start_line;
      map.set(String(r.id), o);
    }
    return map;
  }
}
