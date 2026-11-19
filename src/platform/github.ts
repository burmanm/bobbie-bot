/**
 * Live GitHub `Platform` (R-2): reads the PR and writes the review, thread
 * replies, thread resolutions, the failure comment and the check run, over
 * REST and GraphQL with an installation token (C-5).
 *
 * - One `COMMENT` review per run with inline comments (S-7, I-2 #8).
 * - Thread replies only on this bot's own finding threads.
 * - A thread is resolved only when it is this bot's own (Bot-type author and
 *   this bot's finding marker, never login alone) and this run has just
 *   posted a "Verified fixed" reply in it (S-7, Q-9).
 * - The "review could not complete" comment is found by its hidden marker
 *   and updated in place (S-9); a later successful run updates it again
 *   instead of leaving the stale failure text.
 * - A newer push supersedes the run: when the head SHA moved before
 *   publishing, nothing is posted to the old head; `publish` throws
 *   `SupersededError` and the check completes neutral with that reason
 *   (S-9).
 *
 * Reply and resolution failures do not undo the posted review; they are
 * returned as warnings. A failed review post throws.
 */
import { completeCheckRun, openCheckRun } from "./github-checks.ts";
import { type GitHubClient, GitHubApiError, RateLimitError } from "./github-client.ts";
import { failureMarker, isOwnFailureComment, isOwnFindingRoot, stripMarkers } from "./github-markers.ts";
import type {
  Author,
  CheckRunCompletion,
  Platform,
  PrComment,
  Publication,
  PublishResult,
  PullRequestInfo,
  ReviewPayload,
  ThreadResolution,
} from "./types.ts";

const DIFF_ACCEPT = "application/vnd.github.v3.diff";

interface UserJson {
  login?: string;
  type?: string;
}
interface PullJson {
  number: number;
  title?: string;
  body?: string | null;
  user?: UserJson | null;
  labels?: Array<{ name?: string }>;
  draft?: boolean;
  html_url?: string;
  base: { sha: string; ref?: string };
  head: { sha: string; ref?: string };
}
interface ReviewCommentJson {
  id: number;
  user?: UserJson | null;
  body?: string;
  path?: string;
  line?: number | null;
  start_line?: number | null;
  in_reply_to_id?: number;
  created_at?: string;
}
interface IssueCommentJson {
  id: number;
  user?: UserJson | null;
  body?: string;
  created_at?: string;
}
interface ReviewJson {
  id: number;
  user?: UserJson | null;
  body?: string | null;
  submitted_at?: string;
}
interface ThreadInfo {
  threadId: string;
  isResolved: boolean;
}

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved comments(first:1){nodes{databaseId}}}}}}}`;
const RESOLVE_MUTATION = `mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}`;

const VERIFIED_FIXED = /^\s*\*\*Verified fixed\b/;

function author(u: UserJson | null | undefined): Author {
  return { login: u?.login ?? "ghost", type: u?.type ?? "User" };
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function reviewCommentOf(c: ReviewCommentJson, resolved?: boolean): PrComment {
  const pc: PrComment = { id: String(c.id), kind: "review-comment", author: author(c.user), body: c.body ?? "" };
  if (c.path !== undefined) pc.path = c.path;
  if (typeof c.line === "number") pc.line = c.line;
  if (typeof c.start_line === "number") pc.startLine = c.start_line;
  if (c.in_reply_to_id !== undefined) pc.inReplyTo = String(c.in_reply_to_id);
  else if (resolved !== undefined) pc.threadResolved = resolved;
  if (c.created_at !== undefined) pc.createdAt = c.created_at;
  return pc;
}

export function issueCommentOf(c: IssueCommentJson): PrComment {
  const pc: PrComment = { id: String(c.id), kind: "issue-comment", author: author(c.user), body: c.body ?? "" };
  if (c.created_at !== undefined) pc.createdAt = c.created_at;
  return pc;
}

/** The run's head moved before publishing: nothing is posted to the old head (S-9). */
export class SupersededError extends Error {
  override name = "SupersededError";
  readonly from: string;
  readonly to: string;
  constructor(from: string, to: string) {
    super(`superseded by a newer push: the head moved from ${short(from)} to ${short(to)} before publishing, so nothing was posted for ${short(from)}`);
    this.from = from;
    this.to = to;
  }
}

export interface GitHubPlatformOptions {
  client: GitHubClient;
  /** owner/name */
  repo: string;
  number: number;
  /** `ai-review/<name>`: the bot id in markers (the pipeline's check name). */
  botId: string;
  /** Link on the check run, e.g. the Actions run URL. */
  detailsUrl?: string;
  log?: (line: string) => void;
  now?: () => Date;
}

/** What the live platform did, for the CLI's output. */
export interface GitHubReport {
  live: true;
  repo: string;
  pull_number: number;
  review_id?: string;
  comment_ids: string[];
  failure_comment_id?: string;
  check_run?: { id: number; name: string; head_sha: string; conclusion: string; title: string };
  superseded?: { from: string; to: string };
  warnings: string[];
}

export class GitHubPlatform implements Platform {
  readonly kind = "github";
  readonly repo: string;
  readonly number: number;
  readonly botId: string;
  readonly report: GitHubReport;

  private readonly client: GitHubClient;
  private readonly detailsUrl: string | undefined;
  private readonly log: (line: string) => void;
  private readonly now: () => Date;
  private pr: PullRequestInfo | undefined;
  private comments: PrComment[] | undefined;
  private threads: Map<string, ThreadInfo> | undefined;
  private checkRunId: number | undefined;
  private superseded: SupersededError | undefined;

  constructor(o: GitHubPlatformOptions) {
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(o.repo)) throw new Error(`invalid repository: ${o.repo}`);
    if (!Number.isSafeInteger(o.number) || o.number < 1) throw new Error(`invalid PR number: ${o.number}`);
    failureMarker(o.botId); // validates the id
    this.client = o.client;
    this.repo = o.repo;
    this.number = o.number;
    this.botId = o.botId;
    this.detailsUrl = o.detailsUrl;
    this.log = o.log ?? (() => {});
    this.now = o.now ?? (() => new Date());
    this.report = { live: true, repo: o.repo, pull_number: o.number, comment_ids: [], warnings: [] };
  }

  private get base(): string {
    return `repos/${this.repo}`;
  }

  // ---- reads ---------------------------------------------------------------

  private async fetchPull(): Promise<PullJson> {
    return this.client.get<PullJson>(`${this.base}/pulls/${this.number}`);
  }

  async getPullRequest(): Promise<PullRequestInfo> {
    const pr = await this.fetchPull();
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
    // The head this run reviews: the one seen first.
    this.pr ??= info;
    return info;
  }

  async getDiff(sinceSha?: string): Promise<string | undefined> {
    if (sinceSha === undefined) return this.client.get<string>(`${this.base}/pulls/${this.number}`, { accept: DIFF_ACCEPT, text: true });
    if (!/^[0-9a-f]{7,64}$/.test(sinceSha)) return undefined;
    const head = (this.pr ?? (await this.getPullRequest())).headSha;
    try {
      // Only when the earlier head is an ancestor of the new one; after a
      // force push the three-dot compare would diff from a merge base instead.
      const cmp = await this.client.get<{ status?: string }>(`${this.base}/compare/${sinceSha}...${head}?per_page=1`);
      if (cmp.status !== "ahead" && cmp.status !== "identical") return undefined;
      return await this.client.get<string>(`${this.base}/compare/${sinceSha}...${head}`, { accept: DIFF_ACCEPT, text: true });
    } catch (e) {
      if (e instanceof RateLimitError || !(e instanceof GitHubApiError)) throw e;
      this.log(`incremental diff since ${short(sinceSha)} unavailable (${e.message}); full review`);
      return undefined;
    }
  }

  async listComments(): Promise<PrComment[]> {
    const [reviewComments, issueComments, reviews, threads] = await Promise.all([
      this.client.paginate<ReviewCommentJson>(`${this.base}/pulls/${this.number}/comments`),
      this.client.paginate<IssueCommentJson>(`${this.base}/issues/${this.number}/comments`),
      this.client.paginate<ReviewJson>(`${this.base}/pulls/${this.number}/reviews`),
      this.loadThreads().catch((e: unknown) => {
        // Unknown resolution state: threads are treated as open, as in the dry run.
        this.log(`review threads unavailable (${message(e)}); treating threads as open`);
        return undefined;
      }),
    ]);
    if (threads !== undefined) this.threads = threads;
    const out: PrComment[] = [];
    for (const c of reviewComments) out.push(reviewCommentOf(c, threads?.get(String(c.id))?.isResolved));
    for (const c of issueComments) out.push(issueCommentOf(c));
    for (const r of reviews) {
      if (!r.body) continue;
      const pc: PrComment = { id: String(r.id), kind: "review", author: author(r.user), body: r.body };
      if (r.submitted_at !== undefined) pc.createdAt = r.submitted_at;
      out.push(pc);
    }
    this.comments = out;
    return out;
  }

  /** Thread root comment id → GraphQL thread id and state. */
  private async loadThreads(): Promise<Map<string, ThreadInfo>> {
    const [owner, name] = this.repo.split("/");
    type Page = {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            nodes?: Array<{ id: string; isResolved: boolean; comments?: { nodes?: Array<{ databaseId?: number | null }> } }>;
          };
        };
      };
    };
    const map = new Map<string, ThreadInfo>();
    let after: string | null = null;
    for (let page = 0; page < 50; page++) {
      const data: Page = await this.client.graphql<Page>(THREADS_QUERY, { owner, name, number: this.number, after });
      const threads = data.repository?.pullRequest?.reviewThreads;
      for (const t of threads?.nodes ?? []) {
        const id = t.comments?.nodes?.[0]?.databaseId;
        if (typeof id === "number") map.set(String(id), { threadId: t.id, isResolved: t.isResolved });
      }
      if (!threads?.pageInfo?.hasNextPage || !threads.pageInfo.endCursor) return map;
      after = threads.pageInfo.endCursor;
    }
    return map;
  }

  // ---- check run -----------------------------------------------------------

  async startCheck(name: string, headSha: string): Promise<void> {
    this.checkRunId = await openCheckRun(this.client, this.repo, name, headSha, {
      now: this.now,
      ...(this.detailsUrl === undefined ? {} : { detailsUrl: this.detailsUrl }),
    });
  }

  async completeCheck(c: CheckRunCompletion): Promise<void> {
    const headSha = c.headSha || this.pr?.headSha || "";
    if (headSha === "") {
      throw new Error("cannot complete the check: the head SHA is unknown (the PR could not be read); the workflow's always-run step completes it");
    }
    const completion: CheckRunCompletion = { ...c, headSha };
    if (this.superseded !== undefined && c.conclusion === "neutral") completion.title = "Superseded by a newer push";
    const r = await completeCheckRun(this.client, this.repo, completion, {
      onlyIfIncomplete: false,
      now: this.now,
      ...(this.checkRunId === undefined ? {} : { id: this.checkRunId }),
      ...(this.detailsUrl === undefined ? {} : { detailsUrl: this.detailsUrl }),
    });
    this.checkRunId = r.id;
    this.report.check_run = { id: r.id, name: c.name, head_sha: headSha, conclusion: c.conclusion, title: completion.title };
  }

  // ---- publish -------------------------------------------------------------

  async publish(p: Publication): Promise<PublishResult> {
    const warnings: string[] = [];
    const warn = (w: string) => {
      warnings.push(w);
      this.report.warnings.push(w);
      this.log(w);
    };
    const ids: string[] = [];
    const writesToHead = p.review !== undefined || p.threadReplies.length > 0 || p.resolveThreads.length > 0;

    // S-9: never publish to a head that a newer push replaced.
    if (this.superseded === undefined) {
      const expected = p.review?.commit_id ?? this.pr?.headSha;
      if (expected !== undefined) {
        const current = (await this.fetchPull()).head.sha;
        if (current !== expected) {
          this.superseded = new SupersededError(expected, current);
          this.report.superseded = { from: expected, to: current };
        }
      }
    }
    if (this.superseded !== undefined) {
      if (writesToHead) throw this.superseded;
      // A failure comment for a superseded run: the newer run speaks for the PR.
      this.log(`failure comment not posted: ${this.superseded.message}`);
      return { commentIds: [] };
    }

    if (p.review !== undefined) {
      const posted = await this.createReview(p.review, warn);
      ids.push(...posted);
      this.report.review_id = posted[0]!;
    }

    // Replies, then resolutions (S-7). Root id → body of the reply posted now.
    const replied = new Map<string, string>();
    for (const r of p.threadReplies) {
      const rootId = String(r.in_reply_to);
      try {
        if ((await this.ownRoot(rootId)) === undefined) {
          warn(`reply to comment ${rootId} not posted: not a thread of ${this.botId}`);
          continue;
        }
        ids.push(await this.reply(rootId, r.body));
        replied.set(rootId, r.body);
      } catch (e) {
        warn(`reply to comment ${rootId} failed: ${message(e)}`);
      }
    }
    for (const t of p.resolveThreads) {
      try {
        await this.resolveOwnThread(t, replied, warn);
      } catch (e) {
        warn(`thread of comment ${t.comment_id} not resolved: ${message(e)}`);
      }
    }

    if (p.failureComment !== undefined) {
      const id = await this.upsertFailureComment(p.failureComment);
      ids.push(id);
      this.report.failure_comment_id = id;
    } else if (p.review !== undefined) {
      try {
        await this.retireFailureComment(p.review.commit_id);
      } catch (e) {
        warn(`earlier failure comment not updated: ${message(e)}`);
      }
    }

    this.report.comment_ids.push(...ids);
    return warnings.length === 0 ? { commentIds: ids } : { commentIds: ids, warnings };
  }

  /** One COMMENT review (I-2 #8). Returns the review id, then its inline comment ids. */
  private async createReview(review: ReviewPayload, warn: (w: string) => void): Promise<string[]> {
    if (review.event !== "COMMENT") throw new Error(`refusing review event ${String(review.event)}: the bot only comments (P-8, I-2 #8)`);
    const path = `${this.base}/pulls/${this.number}/reviews`;
    const markerLine = review.body.split(/\r?\n/).find((l) => /^<!-- review-bot:summary .* -->$/.test(l.trim()))?.trim();
    // A 5xx after GitHub created the review must not post a second one: look for this run's summary marker first.
    const probe =
      markerLine === undefined
        ? undefined
        : async () =>
            (await this.client.paginate<ReviewJson>(path)).find(
              (r) => r.user?.type === "Bot" && (r.body ?? "").split(/\r?\n/).some((l) => l.trim() === markerLine),
            );
    const post = (payload: ReviewPayload) => this.client.request<ReviewJson>("POST", path, { body: payload, ...(probe === undefined ? {} : { probe }) });

    let res;
    try {
      res = await post(review);
    } catch (e) {
      // GitHub rejects the whole review when one inline anchor is not in the
      // diff. Keep the review: move the inline comments into its body.
      if (!(e instanceof GitHubApiError) || e.status !== 422 || review.comments.length === 0) throw e;
      warn(`inline comments rejected (${e.message}); ${review.comments.length} finding(s) moved into the review body`);
      res = await post(foldInlineComments(review));
    }
    const id = String(res.data.id);
    const out = [id];
    try {
      const inline = await this.client.paginate<{ id: number }>(`${path}/${id}/comments`);
      out.push(...inline.map((c) => String(c.id)));
    } catch (e) {
      warn(`inline comment ids of review ${id} not read: ${message(e)}`);
    }
    return out;
  }

  /** The thread root with this id if it is this bot's own finding (Bot author + marker). */
  private async ownRoot(id: string): Promise<PrComment | undefined> {
    let c = this.comments?.find((x) => x.id === id && x.kind === "review-comment");
    if (c === undefined) {
      // Not seen at intake (or listComments not called): read again once.
      const fresh = await this.client.get<ReviewCommentJson>(`${this.base}/pulls/comments/${encodeURIComponent(id)}`).catch(() => undefined);
      if (fresh === undefined) return undefined;
      c = reviewCommentOf(fresh);
    }
    return isOwnFindingRoot(c, this.botId) ? c : undefined;
  }

  private async reply(rootId: string, body: string): Promise<string> {
    const res = await this.client.request<{ id: number }>("POST", `${this.base}/pulls/${this.number}/comments/${rootId}/replies`, {
      body: { body },
      probe: async () =>
        (await this.client.paginate<ReviewCommentJson>(`${this.base}/pulls/${this.number}/comments`)).find(
          (c) => String(c.in_reply_to_id) === rootId && c.user?.type === "Bot" && c.body === body,
        ),
    });
    return String(res.data.id);
  }

  /** S-7, Q-9: only this bot's own thread, only after this run's "Verified fixed" reply. */
  private async resolveOwnThread(t: ThreadResolution, replied: Map<string, string>, warn: (w: string) => void): Promise<void> {
    const rootId = String(t.comment_id);
    const reply = replied.get(rootId);
    if (reply === undefined || !VERIFIED_FIXED.test(reply)) {
      warn(`thread of comment ${rootId} not resolved: no "Verified fixed" reply was posted in it by this run`);
      return;
    }
    if ((await this.ownRoot(rootId)) === undefined) {
      warn(`thread of comment ${rootId} not resolved: not a thread of ${this.botId}`);
      return;
    }
    let thread = this.threads?.get(rootId);
    if (thread === undefined) {
      this.threads = await this.loadThreads();
      thread = this.threads.get(rootId);
    }
    if (thread === undefined) {
      warn(`thread of comment ${rootId} not resolved: thread not found`);
      return;
    }
    if (thread.isResolved) return;
    await this.client.graphql(RESOLVE_MUTATION, { threadId: thread.threadId }, { idempotent: true });
    thread.isResolved = true;
  }

  // ---- failure comment (S-9) -------------------------------------------------

  private async findFailureComment(): Promise<PrComment | undefined> {
    const all = await this.client.paginate<IssueCommentJson>(`${this.base}/issues/${this.number}/comments`);
    const own = all.map(issueCommentOf).filter((c) => isOwnFailureComment(c, this.botId));
    return own[own.length - 1];
  }

  private async upsertFailureComment(text: string): Promise<string> {
    const body = `${text.trimEnd()}\n\n${failureMarker(this.botId)}\n`;
    const existing = await this.findFailureComment();
    if (existing !== undefined) {
      if (existing.body !== body) await this.client.request("PATCH", `${this.base}/issues/comments/${existing.id}`, { body: { body } });
      return existing.id;
    }
    const res = await this.client.request<{ id: number }>("POST", `${this.base}/issues/${this.number}/comments`, {
      body: { body },
      probe: async () => {
        const c = await this.findFailureComment();
        return c === undefined ? undefined : { id: Number(c.id) };
      },
    });
    return String(res.data.id);
  }

  /** After a completed review, an earlier failure comment no longer tells the truth: update it in place. */
  private async retireFailureComment(headSha: string): Promise<void> {
    const existing = await this.findFailureComment();
    if (existing === undefined) return;
    const body = `An earlier automated review attempt on this pull request could not complete. The review of \`${short(headSha)}\` completed; see the latest review.\n\n${failureMarker(this.botId)}\n`;
    if (existing.body !== body) await this.client.request("PATCH", `${this.base}/issues/comments/${existing.id}`, { body: { body } });
  }
}

/**
 * The review with its inline comments moved into the body, for when GitHub
 * rejects an inline anchor. Finding markers are dropped from the moved text
 * (they mark inline threads only); the summary marker stays.
 */
export function foldInlineComments(review: ReviewPayload): ReviewPayload {
  const parts = review.comments.map((c) => {
    const where = c.start_line !== undefined && c.start_line !== c.line ? `${c.path}:${c.start_line}-${c.line}` : `${c.path}:${c.line}`;
    return `#### \`${where}\`\n\n${stripMarkers(c.body).trim()}`;
  });
  const lines = review.body.replace(/\s+$/, "").split("\n");
  // Keep the summary marker last.
  const markerAt = lines.findIndex((l) => /^\s*<!-- review-bot:summary .* -->\s*$/.test(l));
  const marker = markerAt >= 0 ? lines.splice(markerAt, 1) : [];
  const section = `### Findings not placed inline\n\nGitHub did not accept these as inline comments, so they are listed here.\n\n${parts.join("\n\n")}`;
  return {
    commit_id: review.commit_id,
    event: "COMMENT",
    body: `${lines.join("\n").replace(/\s+$/, "")}\n\n${section}\n${marker.length ? `\n${marker[0]!.trim()}\n` : ""}`,
    comments: [],
  };
}
