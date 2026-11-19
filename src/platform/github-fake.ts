/**
 * An in-memory GitHub for tests, served through an injected `fetch` (no
 * network, no token). It implements the REST and GraphQL calls the live
 * platform makes, records every request, and can inject faults.
 */
import type { FetchLike } from "./github-client.ts";

export interface FakeUser {
  login: string;
  type: "Bot" | "User";
}

export const ACTIONS_BOT: FakeUser = { login: "github-actions[bot]", type: "Bot" };
export const HUMAN: FakeUser = { login: "dev", type: "User" };

export interface FakeReviewComment {
  id: number;
  user: FakeUser;
  body: string;
  path: string;
  line: number | null;
  start_line?: number | null;
  in_reply_to_id?: number;
  review_id?: number;
  created_at: string;
}
export interface FakeIssueComment {
  id: number;
  user: FakeUser;
  body: string;
  created_at: string;
}
export interface FakeReview {
  id: number;
  user: FakeUser;
  body: string;
  commit_id: string;
  event: string;
  submitted_at: string;
}
export interface FakeThread {
  id: string;
  rootId: number;
  isResolved: boolean;
}
export interface FakeCheckRun {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  output?: { title: string; summary: string };
  details_url?: string;
}

export interface RecordedRequest {
  method: string;
  /** Path without origin and query. */
  path: string;
  query: string;
  url: string;
  body: unknown;
  authorization: string | null;
  accept: string | null;
}

export interface Fault {
  method: string;
  path: RegExp;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Apply the request first, then answer with the fault (an ambiguous failure). */
  afterEffect?: boolean;
  /** Throw from fetch instead (a network error). */
  network?: boolean;
  /** How many matching requests fail (default 1). */
  times?: number;
}

export interface FakeGitHubOptions {
  repo?: string;
  number?: number;
  headSha?: string;
  baseSha?: string;
  diff?: string;
  /** "path:line" anchors GitHub refuses (not in the diff). */
  invalidAnchors?: string[];
  /** Page size for list endpoints (default: honour per_page). */
  pageSize?: number;
  /** The identity the token posts as. */
  as?: FakeUser;
  /** User or Bot type per identity; GraphQL refuses thread resolution when false. */
  canResolveThreads?: boolean;
}

export class FakeGitHub {
  readonly origin = "https://api.github.test";
  readonly repo: string;
  readonly number: number;
  headSha: string;
  baseSha: string;
  diff: string;
  compare = new Map<string, { status: string; diff: string }>();
  invalidAnchors: Set<string>;
  pageSize: number | undefined;
  as: FakeUser;
  canResolveThreads: boolean;

  reviewComments: FakeReviewComment[] = [];
  issueComments: FakeIssueComment[] = [];
  reviews: FakeReview[] = [];
  threads: FakeThread[] = [];
  checkRuns: FakeCheckRun[] = [];
  requests: RecordedRequest[] = [];
  faults: Fault[] = [];
  /** Called before each request is handled (e.g. to move the head). */
  onRequest: ((r: RecordedRequest) => void) | undefined;

  private nextId = 1000;
  private clock = 0;

  constructor(o: FakeGitHubOptions = {}) {
    this.repo = o.repo ?? "o/r";
    this.number = o.number ?? 7;
    this.headSha = o.headSha ?? "b".repeat(40);
    this.baseSha = o.baseSha ?? "a".repeat(40);
    this.diff = o.diff ?? "";
    this.invalidAnchors = new Set(o.invalidAnchors ?? []);
    this.pageSize = o.pageSize;
    this.as = o.as ?? ACTIONS_BOT;
    this.canResolveThreads = o.canResolveThreads ?? true;
  }

  id(): number {
    return this.nextId++;
  }
  private time(): string {
    return new Date(Date.UTC(2026, 10, 20, 0, 0, this.clock++)).toISOString();
  }

  /** Seed a thread root review comment (and its thread). */
  addThreadRoot(user: FakeUser, body: string, path = "a.go", line = 3, resolved = false): FakeReviewComment {
    const c: FakeReviewComment = { id: this.id(), user, body, path, line, created_at: this.time() };
    this.reviewComments.push(c);
    this.threads.push({ id: `T_${c.id}`, rootId: c.id, isResolved: resolved });
    return c;
  }
  addIssueComment(user: FakeUser, body: string): FakeIssueComment {
    const c: FakeIssueComment = { id: this.id(), user, body, created_at: this.time() };
    this.issueComments.push(c);
    return c;
  }

  readonly fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const headers = new Headers(init.headers);
    const rec: RecordedRequest = {
      method: init.method ?? "GET",
      path: u.pathname,
      query: u.search,
      url,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      authorization: headers.get("authorization"),
      accept: headers.get("accept"),
    };
    this.requests.push(rec);
    this.onRequest?.(rec);
    const fault = this.faults.find((f) => f.method === rec.method && f.path.test(rec.path) && (f.times ?? 1) > 0);
    if (fault !== undefined) {
      fault.times = (fault.times ?? 1) - 1;
      if (fault.afterEffect) this.handle(rec, u);
      if (fault.network) throw new TypeError("fetch failed");
      return json(fault.status, fault.body ?? { message: `injected ${fault.status}` }, fault.headers);
    }
    return this.handle(rec, u);
  };

  private list<T>(items: T[], u: URL): Response {
    const per = this.pageSize ?? Number(u.searchParams.get("per_page") ?? 30);
    const page = Number(u.searchParams.get("page") ?? 1);
    const slice = items.slice((page - 1) * per, page * per);
    const headers: Record<string, string> = {};
    if (page * per < items.length) {
      const next = new URL(u);
      next.searchParams.set("page", String(page + 1));
      headers.link = `<${next.toString()}>; rel="next"`;
    }
    return json(200, slice, headers);
  }

  private pull() {
    return {
      number: this.number,
      title: "t",
      body: "b",
      user: HUMAN,
      labels: [{ name: "enhancement" }],
      draft: false,
      html_url: `https://github.test/${this.repo}/pull/${this.number}`,
      base: { sha: this.baseSha, ref: "main" },
      head: { sha: this.headSha, ref: "topic" },
    };
  }

  private handle(r: RecordedRequest, u: URL): Response {
    const base = `/repos/${this.repo}`;
    const p = r.path;
    const m = (re: RegExp) => re.exec(p);
    const body = (r.body ?? {}) as Record<string, unknown>;
    let x: RegExpExecArray | null;

    if (r.method === "POST" && p === "/graphql") return this.graphql(body);

    if (r.method === "GET" && p === `${base}/pulls/${this.number}`) {
      if (r.accept?.includes("diff")) return text(200, this.diff);
      return json(200, this.pull());
    }
    if ((x = m(new RegExp(`^${base}/compare/([0-9a-f]+)\\.\\.\\.([0-9a-f]+)$`)))) {
      const c = this.compare.get(`${x[1]}...${x[2]}`);
      if (c === undefined) return json(404, { message: "Not Found" });
      return r.accept?.includes("diff") ? text(200, c.diff) : json(200, { status: c.status });
    }
    if (r.method === "GET" && p === `${base}/pulls/${this.number}/comments`) return this.list(this.reviewComments, u);
    if (r.method === "GET" && p === `${base}/issues/${this.number}/comments`) return this.list(this.issueComments, u);
    if (r.method === "GET" && p === `${base}/pulls/${this.number}/reviews`) return this.list(this.reviews, u);
    if (r.method === "GET" && (x = m(new RegExp(`^${base}/pulls/comments/(\\d+)$`)))) {
      const c = this.reviewComments.find((c) => c.id === Number(x![1]));
      return c ? json(200, c) : json(404, { message: "Not Found" });
    }
    if (r.method === "GET" && (x = m(new RegExp(`^${base}/pulls/${this.number}/reviews/(\\d+)/comments$`)))) {
      return this.list(this.reviewComments.filter((c) => c.review_id === Number(x![1])), u);
    }
    if (r.method === "POST" && p === `${base}/pulls/${this.number}/reviews`) {
      const comments = (body.comments ?? []) as Array<{ path: string; line: number; start_line?: number; body: string }>;
      if (body.commit_id !== this.headSha && !this.knownCommit(String(body.commit_id))) return json(422, { message: "Unprocessable Entity", errors: ["commit_id is not part of the pull request"] });
      for (const c of comments) {
        if (this.invalidAnchors.has(`${c.path}:${c.line}`)) {
          return json(422, { message: "Unprocessable Entity", errors: ["Line could not be resolved"] });
        }
      }
      const review: FakeReview = { id: this.id(), user: this.as, body: String(body.body ?? ""), commit_id: String(body.commit_id), event: String(body.event), submitted_at: this.time() };
      this.reviews.push(review);
      for (const c of comments) {
        const rc = this.addThreadRoot(this.as, c.body, c.path, c.line);
        rc.review_id = review.id;
        if (c.start_line !== undefined) rc.start_line = c.start_line;
      }
      return json(200, review);
    }
    if (r.method === "POST" && (x = m(new RegExp(`^${base}/pulls/${this.number}/comments/(\\d+)/replies$`)))) {
      const root = this.reviewComments.find((c) => c.id === Number(x![1]));
      if (!root) return json(404, { message: "Not Found" });
      const c: FakeReviewComment = { id: this.id(), user: this.as, body: String(body.body), path: root.path, line: root.line, in_reply_to_id: root.id, created_at: this.time() };
      this.reviewComments.push(c);
      return json(201, c);
    }
    if (r.method === "POST" && p === `${base}/issues/${this.number}/comments`) {
      return json(201, this.addIssueComment(this.as, String(body.body)));
    }
    if (r.method === "PATCH" && (x = m(new RegExp(`^${base}/issues/comments/(\\d+)$`)))) {
      const c = this.issueComments.find((c) => c.id === Number(x![1]));
      if (!c) return json(404, { message: "Not Found" });
      if (c.user.login !== this.as.login) return json(403, { message: "Resource not accessible by integration" });
      c.body = String(body.body);
      return json(200, c);
    }
    if (r.method === "GET" && (x = m(new RegExp(`^${base}/commits/([0-9a-f]+)/check-runs$`)))) {
      const name = u.searchParams.get("check_name");
      const runs = this.checkRuns.filter((c) => c.head_sha === x![1] && (name === null || c.name === name));
      return json(200, { total_count: runs.length, check_runs: [...runs].reverse() });
    }
    if (r.method === "POST" && p === `${base}/check-runs`) {
      const c: FakeCheckRun = { id: this.id(), name: String(body.name), head_sha: String(body.head_sha), status: String(body.status ?? "queued"), conclusion: (body.conclusion as string | undefined) ?? null };
      if (body.output) c.output = body.output as FakeCheckRun["output"] & object;
      if (body.details_url) c.details_url = String(body.details_url);
      this.checkRuns.push(c);
      return json(201, c);
    }
    if (r.method === "PATCH" && (x = m(new RegExp(`^${base}/check-runs/(\\d+)$`)))) {
      const c = this.checkRuns.find((c) => c.id === Number(x![1]));
      if (!c) return json(404, { message: "Not Found" });
      if (body.status !== undefined) c.status = String(body.status);
      if (body.conclusion !== undefined) c.conclusion = String(body.conclusion);
      if (body.output) c.output = body.output as FakeCheckRun["output"] & object;
      if (body.details_url) c.details_url = String(body.details_url);
      return json(200, c);
    }
    return json(404, { message: `fake GitHub: no route for ${r.method} ${p}` });
  }

  /** Commits the PR has had as its head (for posting to a superseded head). */
  previousHeads = new Set<string>();
  private knownCommit(sha: string): boolean {
    return this.previousHeads.has(sha);
  }

  /** A newer push. */
  push(newHead: string): void {
    this.previousHeads.add(this.headSha);
    this.headSha = newHead;
  }

  private graphql(body: Record<string, unknown>): Response {
    const query = String(body.query);
    const vars = (body.variables ?? {}) as Record<string, unknown>;
    if (query.startsWith("mutation")) {
      if (!this.canResolveThreads) return json(200, { data: { resolveReviewThread: null }, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] });
      const t = this.threads.find((t) => t.id === vars.threadId);
      if (!t) return json(200, { errors: [{ type: "NOT_FOUND", message: "Could not resolve to a node" }] });
      t.isResolved = true;
      return json(200, { data: { resolveReviewThread: { thread: { id: t.id, isResolved: true } } } });
    }
    const per = this.pageSize ?? 100;
    const start = vars.after === null || vars.after === undefined ? 0 : Number(String(vars.after).slice(1));
    const slice = this.threads.slice(start, start + per);
    const end = start + slice.length;
    return json(200, {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: end < this.threads.length, endCursor: `c${end}` },
              nodes: slice.map((t) => ({ id: t.id, isResolved: t.isResolved, comments: { nodes: [{ databaseId: t.rootId }] } })),
            },
          },
        },
      },
    });
  }

  /** Requests other than reads. */
  writes(): RecordedRequest[] {
    return this.requests.filter((r) => r.method !== "GET" && !(r.path === "/graphql" && !String((r.body as { query?: string }).query).startsWith("mutation")));
  }
}

function json(status: number, data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}
function text(status: number, data: string): Response {
  return new Response(data, { status, headers: { "content-type": "text/plain" } });
}
