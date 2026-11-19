/**
 * The `Platform` interface (A-2): everything the pipeline needs from the
 * code host. Reads: PR metadata, diff, existing comments. Writes: the check
 * run, one review, thread replies, thread resolution (S-1, S-7).
 *
 * Two implementations: the dry run (R-1), which reads (from a fixture or
 * GitHub, read-only) and records the writes instead of performing them, and
 * the live GitHub platform (R-2, `github.ts`). Shapes follow GitHub's REST
 * payloads so the live platform passes them through unchanged.
 */

export interface Author {
  login: string;
  /** GitHub user type: "Bot", "User", "Organization". Markers are trusted only from "Bot" (S-7). */
  type: string;
}

export interface PullRequestInfo {
  /** owner/name */
  repo: string;
  number: number;
  title: string;
  /** The PR description. Untrusted. */
  body: string;
  author: Author;
  labels: string[];
  draft: boolean;
  baseSha: string;
  headSha: string;
  baseRef?: string;
  headRef?: string;
  url?: string;
}

export type CommentKind = "review-comment" | "issue-comment" | "review";

/** One existing comment on the PR, by anyone (S-1). */
export interface PrComment {
  /** GitHub's numeric id, as a string. */
  id: string;
  kind: CommentKind;
  author: Author;
  body: string;
  /** Review comments: head path. */
  path?: string;
  /** Review comments: current head-side line, absent when the comment is outdated. */
  line?: number;
  startLine?: number;
  /** Review comments: id of the thread's first comment, for replies. */
  inReplyTo?: string;
  /** Thread roots: whether the thread is resolved, when known. */
  threadResolved?: boolean;
  createdAt?: string;
}

export type CheckConclusion = "success" | "skipped" | "neutral";

export interface CheckRunCompletion {
  /** `ai-review/<name>` (I-2 #1). */
  name: string;
  headSha: string;
  conclusion: CheckConclusion;
  /** One line. */
  title: string;
  summary: string;
}

/** An inline review comment in GitHub's "create a review" payload shape. */
export interface ReviewCommentPayload {
  path: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

/** GitHub's "create a review" payload. The event is always COMMENT (P-8, I-2 #8). */
export interface ReviewPayload {
  commit_id: string;
  event: "COMMENT";
  body: string;
  comments: ReviewCommentPayload[];
}

export interface ThreadReply {
  /** Id of the thread's first comment. */
  in_reply_to: number | string;
  body: string;
}

export interface ThreadResolution {
  /** Id of the thread's first comment; the bot resolves only its own threads (S-7, Q-9). */
  comment_id: number | string;
  reason: string;
}

/** What one run publishes (S-7). */
export interface Publication {
  review?: ReviewPayload;
  threadReplies: ThreadReply[];
  /** Applied after the replies. */
  resolveThreads: ThreadResolution[];
  /** S-9: "review could not complete" comment, updated in place by a live platform. */
  failureComment?: string;
}

export interface PublishResult {
  /** Ids of what was posted; empty for a dry run. */
  commentIds: string[];
  /**
   * Parts that were not published while the review itself was (a reply or
   * a thread resolution that failed, inline comments moved into the body).
   */
  warnings?: string[];
}

export interface Platform {
  readonly kind: string;
  getPullRequest(): Promise<PullRequestInfo>;
  /**
   * The PR diff (base...head). With `sinceSha`, the diff of the commits
   * since that SHA only, or undefined when the platform cannot produce it
   * (for example after a force push) — the run then falls back to full.
   */
  getDiff(sinceSha?: string): Promise<string | undefined>;
  listComments(): Promise<PrComment[]>;
  /** S-1: open `ai-review/<name>` on the head SHA as in progress. */
  startCheck(name: string, headSha: string): Promise<void>;
  /** S-7, S-9: always called, once, on every exit path. */
  completeCheck(completion: CheckRunCompletion): Promise<void>;
  publish(publication: Publication): Promise<PublishResult>;
}
