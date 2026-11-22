/**
 * Read-only access to a GitHub PR through the `gh` CLI (R-1 dry run). Only
 * GET requests and one GraphQL query; nothing is written. `gh` supplies its
 * own authentication; this module never sees the token.
 */
import type { PrReader } from "./dry-run.ts";
import { attributeComments, type RecordingRun } from "./github-markers.ts";
import { defaultExec, type Exec } from "./snapshot.ts";
import type { Author, PrComment, PullRequestInfo } from "./types.ts";

const DIFF_ACCEPT = "Accept: application/vnd.github.v3.diff";

interface GhUser {
  login?: string;
  type?: string;
}

function author(u: GhUser | null | undefined): Author {
  return { login: u?.login ?? "ghost", type: u?.type ?? "User" };
}

/** Parse "owner/repo#123", "owner/repo/pull/123" or a PR URL. */
export function parsePrRef(ref: string): { repo: string; number: number } | undefined {
  const m =
    /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)(?:#|\/pull\/|\/pulls\/)(\d+)\/?$/.exec(ref.trim()) ?? undefined;
  if (!m) return undefined;
  return { repo: m[1]!, number: Number(m[2]) };
}

export class GhPrReader implements PrReader {
  readonly kind = "github";

  readonly repo: string;
  readonly number: number;
  private readonly exec: Exec;
  private readonly botId: string;

  /** `botId`: whose check runs say which comments are the bot's own (D-5, H-50). */
  constructor(repo: string, number: number, exec: Exec = defaultExec, botId = "ai-review/main") {
    this.botId = botId;
    this.repo = repo;
    this.number = number;
    this.exec = exec;
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error(`invalid repository: ${repo}`);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error(`invalid PR number: ${number}`);
  }

  private async api(args: string[]): Promise<string> {
    const { stdout } = await this.exec("gh", ["api", "--method", "GET", ...args]);
    return stdout.toString("utf8");
  }

  /** A paginated list endpoint, one JSON object per line. */
  private async list<T>(path: string, jq = ".[]"): Promise<T[]> {
    const text = await this.api(["--paginate", "--jq", jq, path]);
    return text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as T);
  }

  async getPullRequest(): Promise<PullRequestInfo> {
    const pr = JSON.parse(await this.api([`repos/${this.repo}/pulls/${this.number}`])) as {
      number: number;
      title?: string;
      body?: string | null;
      user?: GhUser;
      labels?: Array<{ name?: string }>;
      draft?: boolean;
      html_url?: string;
      base: { sha: string; ref?: string };
      head: { sha: string; ref?: string };
    };
    const info: PullRequestInfo = {
      repo: this.repo,
      number: pr.number,
      title: pr.title ?? "",
      body: pr.body ?? "",
      author: author(pr.user),
      labels: (pr.labels ?? []).map((l) => l.name ?? "").filter((n) => n !== ""),
      draft: pr.draft === true,
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
    };
    if (pr.base.ref !== undefined) info.baseRef = pr.base.ref;
    if (pr.head.ref !== undefined) info.headRef = pr.head.ref;
    if (pr.html_url !== undefined) info.url = pr.html_url;
    return info;
  }

  async getDiff(sinceSha?: string): Promise<string | undefined> {
    if (sinceSha === undefined) return this.api(["-H", DIFF_ACCEPT, `repos/${this.repo}/pulls/${this.number}`]);
    if (!/^[0-9a-f]{7,64}$/.test(sinceSha)) return undefined;
    const pr = await this.getPullRequest();
    try {
      return await this.api(["-H", DIFF_ACCEPT, `repos/${this.repo}/compare/${sinceSha}...${pr.headSha}`]);
    } catch {
      // Force-pushed away or otherwise unavailable: the run falls back to a full review.
      return undefined;
    }
  }

  async listComments(): Promise<PrComment[]> {
    type ReviewComment = {
      id: number;
      user?: GhUser;
      body?: string;
      path?: string;
      line?: number | null;
      start_line?: number | null;
      in_reply_to_id?: number;
      pull_request_review_id?: number | null;
      created_at?: string;
    };
    type IssueComment = { id: number; user?: GhUser; body?: string; created_at?: string };
    type Review = { id: number; user?: GhUser; body?: string | null; commit_id?: string | null; submitted_at?: string };

    const [reviewComments, issueComments, reviews, resolved] = await Promise.all([
      this.list<ReviewComment>(`repos/${this.repo}/pulls/${this.number}/comments`),
      this.list<IssueComment>(`repos/${this.repo}/issues/${this.number}/comments`),
      this.list<Review>(`repos/${this.repo}/pulls/${this.number}/reviews`),
      this.resolvedThreads(),
    ]);

    const out: PrComment[] = [];
    for (const c of reviewComments) {
      const pc: PrComment = { id: String(c.id), kind: "review-comment", author: author(c.user), body: c.body ?? "" };
      if (c.path !== undefined) pc.path = c.path;
      if (typeof c.line === "number") pc.line = c.line;
      if (typeof c.start_line === "number") pc.startLine = c.start_line;
      if (c.in_reply_to_id !== undefined) pc.inReplyTo = String(c.in_reply_to_id);
      else if (resolved.has(String(c.id))) pc.threadResolved = resolved.get(String(c.id))!;
      if (typeof c.pull_request_review_id === "number") pc.reviewId = String(c.pull_request_review_id);
      if (c.created_at !== undefined) pc.createdAt = c.created_at;
      out.push(pc);
    }
    for (const c of issueComments) {
      const pc: PrComment = { id: String(c.id), kind: "issue-comment", author: author(c.user), body: c.body ?? "" };
      if (c.created_at !== undefined) pc.createdAt = c.created_at;
      out.push(pc);
    }
    for (const r of reviews) {
      if (!r.body) continue;
      const pc: PrComment = { id: String(r.id), kind: "review", author: author(r.user), body: r.body };
      if (r.commit_id) pc.commitId = r.commit_id;
      if (r.submitted_at !== undefined) pc.createdAt = r.submitted_at;
      out.push(pc);
    }
    return attributeComments(out, this.botId, (sha) => this.checkRuns(sha));
  }

  /**
   * This bot's check runs on a commit. Unreadable means no record: a dry run
   * posts nothing, so a full review is the safe answer (H-50).
   */
  private async checkRuns(sha: string): Promise<RecordingRun[]> {
    const query = `check_name=${encodeURIComponent(this.botId)}&filter=all&per_page=100`;
    try {
      return await this.list<RecordingRun>(`repos/${this.repo}/commits/${sha}/check-runs?${query}`, ".check_runs[]");
    } catch {
      return [];
    }
  }

  /** Thread root comment id → resolved. First 100 threads; the rest are treated as unknown. */
  private async resolvedThreads(): Promise<Map<string, boolean>> {
    const [owner, name] = this.repo.split("/");
    const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{databaseId}}}}}}}`;
    const map = new Map<string, boolean>();
    try {
      const { stdout } = await this.exec("gh", [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `number=${this.number}`,
      ]);
      const data = JSON.parse(stdout.toString("utf8")) as {
        data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: Array<{ isResolved: boolean; comments: { nodes: Array<{ databaseId: number }> } }> } } } };
      };
      for (const t of data.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []) {
        const id = t.comments.nodes[0]?.databaseId;
        if (id !== undefined) map.set(String(id), t.isResolved);
      }
    } catch {
      // Unknown resolution state: threads are treated as open.
    }
    return map;
  }
}
