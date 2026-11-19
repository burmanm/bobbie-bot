/**
 * Dry-run `Platform` (R-1): reads a PR through a `PrReader` (fixture or
 * GitHub, read-only) and records every write instead of performing it. The
 * recorded output is the would-be review in GitHub payload shape, the same
 * shape as the hand-made reviews in review-process `Claude outputs/*.json`
 * (`review` + `thread_replies`), plus what a live platform would also do:
 * resolve threads and complete the check run.
 */
import type {
  CheckRunCompletion,
  Platform,
  PrComment,
  Publication,
  PublishResult,
  PullRequestInfo,
  ReviewPayload,
  ThreadReply,
  ThreadResolution,
} from "./types.ts";

/** The read half of a platform. */
export interface PrReader {
  readonly kind: string;
  getPullRequest(): Promise<PullRequestInfo>;
  getDiff(sinceSha?: string): Promise<string | undefined>;
  listComments(): Promise<PrComment[]>;
}

export interface CheckRunRecord {
  name: string;
  head_sha: string;
  status: "in_progress" | "completed";
  conclusion?: CheckRunCompletion["conclusion"];
  output?: { title: string; summary: string };
}

/** What a dry run would have posted. */
export interface DryRunOutput {
  dry_run: true;
  repo?: string;
  pull_number?: number;
  review?: ReviewPayload;
  thread_replies: ThreadReply[];
  resolve_threads: ThreadResolution[];
  failure_comment?: string;
  check_run?: CheckRunRecord;
}

export class DryRunPlatform implements Platform {
  readonly kind: string;
  readonly output: DryRunOutput = { dry_run: true, thread_replies: [], resolve_threads: [] };
  private publishCount = 0;
  private completeCount = 0;

  private readonly reader: PrReader;

  constructor(reader: PrReader) {
    this.reader = reader;
    this.kind = `dry-run:${reader.kind}`;
  }

  async getPullRequest(): Promise<PullRequestInfo> {
    const pr = await this.reader.getPullRequest();
    this.output.repo = pr.repo;
    this.output.pull_number = pr.number;
    return pr;
  }

  getDiff(sinceSha?: string): Promise<string | undefined> {
    return this.reader.getDiff(sinceSha);
  }

  listComments(): Promise<PrComment[]> {
    return this.reader.listComments();
  }

  async startCheck(name: string, headSha: string): Promise<void> {
    this.output.check_run = { name, head_sha: headSha, status: "in_progress" };
  }

  async completeCheck(c: CheckRunCompletion): Promise<void> {
    // A live platform completes the check exactly once; make a second call visible.
    if (++this.completeCount > 1) throw new Error("check run completed twice");
    this.output.check_run = {
      name: c.name,
      head_sha: c.headSha,
      status: "completed",
      conclusion: c.conclusion,
      output: { title: c.title, summary: c.summary },
    };
  }

  async publish(p: Publication): Promise<PublishResult> {
    if (++this.publishCount > 1) throw new Error("published twice in one run (S-7: one review per run)");
    if (p.review !== undefined) this.output.review = p.review;
    this.output.thread_replies = [...p.threadReplies];
    this.output.resolve_threads = [...p.resolveThreads];
    if (p.failureComment !== undefined) this.output.failure_comment = p.failureComment;
    return { commentIds: [] };
  }
}
