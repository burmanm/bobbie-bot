/**
 * A pull request as it was at an earlier head SHA (E-2 replays: "the case
 * uses the head SHA at the time the comment was made"). Wraps a `PrReader`:
 *
 * - **head** is the given commit; **base** is its merge base with the PR's
 *   base SHA, which is what the PR's three-dot diff was taken from at that
 *   time. Knowledge is then read from that base (D-7).
 * - **diff** is `base...head` from the compare API.
 * - **comments** are cut to those created at or before the cutoff: the
 *   head commit's committer date, or an explicit `asOf`. The committer
 *   date is a lower bound of when the head was pushed (GitHub keeps no push
 *   time on the PR), so a comment made between the commit and the push is
 *   left out.
 * - **review-comment lines** come from GitHub's `original_*` fields where
 *   the comment was made on this very head; a comment made on an earlier
 *   commit gets no line (treated like an outdated comment: shown to the
 *   reviewer, not matched mechanically). Thread resolution is unknown for
 *   that time and is dropped (threads count as open).
 *
 * Title, description, labels and draft state are today's: GitHub keeps no
 * cheap history of them.
 */
import type { PrReader } from "./dry-run.ts";
import type { PrComment, PullRequestInfo } from "./types.ts";

export interface ReviewCommentOrigin {
  /** The commit the comment was made on (`original_commit_id`). */
  commitId: string;
  line?: number;
  startLine?: number;
}

/** The reads a replay needs beyond a `PrReader`. Implemented by `GhHistory`. */
export interface ReplaySource {
  resolveCommit(sha: string, signal?: AbortSignal): Promise<{ sha: string; committedAt: string }>;
  mergeBase(baseSha: string, headSha: string, signal?: AbortSignal): Promise<string>;
  compareDiff(baseSha: string, headSha: string, signal?: AbortSignal): Promise<string>;
  pullCommits(prNumber: number, signal?: AbortSignal): Promise<string[]>;
  reviewCommentOrigins(prNumber: number, signal?: AbortSignal): Promise<Map<string, ReviewCommentOrigin>>;
}

export interface ReplayInfo {
  headSha: string;
  baseSha: string;
  /** The PR's base SHA today (or at merge), from which the merge base was taken. */
  prBaseSha: string;
  /** Today's head of the PR. */
  currentHeadSha: string;
  /** Comments created after this were left out; history queries stop here too. */
  cutoff: string;
  /** False when the SHA is not among the PR's commits today (force-pushed away, or another branch). */
  inPrCommits: boolean;
  comments: { kept: number; dropped: number; lineFromOriginal: number; lineCleared: number; undated: number };
}

export interface AtHeadOptions {
  /** Cutoff for comments and history instead of the head's committer date (ISO 8601). */
  asOf?: string;
  log?: (line: string) => void;
}

export class AtHeadReader implements PrReader {
  readonly kind: string;
  private readonly inner: PrReader;
  private readonly source: ReplaySource;
  private readonly requested: string;
  private readonly options: AtHeadOptions;
  private resolved: Promise<{ pr: PullRequestInfo; info: ReplayInfo }> | undefined;
  /** Filled once the PR has been read. */
  info: ReplayInfo | undefined;

  constructor(inner: PrReader, source: ReplaySource, headSha: string, options: AtHeadOptions = {}) {
    if (!/^[0-9a-f]{7,40}$/.test(headSha)) throw new Error(`invalid head SHA: ${headSha}`);
    if (options.asOf !== undefined && Number.isNaN(Date.parse(options.asOf))) throw new Error(`invalid time: ${options.asOf}`);
    this.inner = inner;
    this.source = source;
    this.requested = headSha;
    this.options = options;
    this.kind = `${inner.kind}@head`;
  }

  /** The cutoff, once known: comments after it are hidden and history queries stop there. */
  get cutoff(): string | undefined {
    return this.info?.cutoff;
  }

  private resolve(): Promise<{ pr: PullRequestInfo; info: ReplayInfo }> {
    this.resolved ??= (async () => {
      const pr = await this.inner.getPullRequest();
      const head = await this.source.resolveCommit(this.requested);
      const [baseSha, commits] = await Promise.all([this.source.mergeBase(pr.baseSha, head.sha), this.source.pullCommits(pr.number)]);
      const cutoff = this.options.asOf !== undefined ? new Date(this.options.asOf).toISOString() : head.committedAt;
      if (cutoff === "" || Number.isNaN(Date.parse(cutoff))) throw new Error(`no commit time for ${head.sha}; give the cutoff explicitly`);
      const info: ReplayInfo = {
        headSha: head.sha,
        baseSha,
        prBaseSha: pr.baseSha,
        currentHeadSha: pr.headSha,
        cutoff,
        inPrCommits: commits.includes(head.sha),
        comments: { kept: 0, dropped: 0, lineFromOriginal: 0, lineCleared: 0, undated: 0 },
      };
      this.info = info;
      const log = this.options.log ?? (() => {});
      log(`replay at head ${head.sha.slice(0, 7)} (PR head today ${pr.headSha.slice(0, 7)}), base ${baseSha.slice(0, 7)} = merge base with ${pr.baseSha.slice(0, 7)}, cutoff ${cutoff}`);
      if (!info.inPrCommits) log(`replay: ${head.sha.slice(0, 7)} is not among the PR's commits today (force-pushed away?); reviewing it anyway`);
      return { pr: { ...pr, headSha: head.sha, baseSha }, info };
    })();
    return this.resolved;
  }

  async getPullRequest(): Promise<PullRequestInfo> {
    return { ...(await this.resolve()).pr };
  }

  async getDiff(sinceSha?: string): Promise<string | undefined> {
    const { pr } = await this.resolve();
    if (sinceSha === undefined) return this.source.compareDiff(pr.baseSha, pr.headSha);
    if (!/^[0-9a-f]{7,64}$/.test(sinceSha)) return undefined;
    try {
      return await this.source.compareDiff(sinceSha, pr.headSha);
    } catch {
      return undefined;
    }
  }

  async listComments(): Promise<PrComment[]> {
    const { pr, info } = await this.resolve();
    const [all, origins] = await Promise.all([this.inner.listComments(), this.source.reviewCommentOrigins(pr.number)]);
    const cutoff = Date.parse(info.cutoff);
    const counts = { kept: 0, dropped: 0, lineFromOriginal: 0, lineCleared: 0, undated: 0 };
    const out: PrComment[] = [];
    for (const c of all) {
      if (c.createdAt === undefined || Number.isNaN(Date.parse(c.createdAt))) {
        // Without a time it cannot be placed; leaving it out could hide what a reviewer saw, keeping it could leak. Keep, and count.
        counts.undated++;
      } else if (Date.parse(c.createdAt) > cutoff) {
        counts.dropped++;
        continue;
      }
      const copy: PrComment = { ...c };
      delete copy.threadResolved;
      if (c.kind === "review-comment") {
        const origin = origins.get(c.id);
        delete copy.line;
        delete copy.startLine;
        if (origin !== undefined && origin.commitId === pr.headSha && origin.line !== undefined) {
          copy.line = origin.line;
          if (origin.startLine !== undefined) copy.startLine = origin.startLine;
          counts.lineFromOriginal++;
        } else {
          counts.lineCleared++;
        }
      }
      counts.kept++;
      out.push(copy);
    }
    info.comments = counts;
    this.options.log?.(
      `replay comments: ${counts.kept} kept, ${counts.dropped} made after the cutoff left out; review-comment lines: ${counts.lineFromOriginal} from this head, ${counts.lineCleared} unknown${counts.undated ? `; ${counts.undated} without a time kept` : ""}`,
    );
    return out;
  }
}
