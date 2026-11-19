/**
 * In-memory `HistorySource` and `ReplaySource` for tests: no network, no
 * `gh`. Records every call; a method named in `hang` never answers (and
 * ignores its signal), to test that a hung query cannot hold a step.
 */
import {
  type BlameQuery,
  type BlameRange,
  type CommitDetail,
  type CommitQuery,
  type CommitSummary,
  HistoryNotFound,
  type HistorySource,
  type IssueQuery,
  type IssueSummary,
  type LogQuery,
} from "../core/index.ts";
import type { ReplaySource, ReviewCommentOrigin } from "./history-head.ts";

export interface FakeHistoryData {
  /** Commits by full SHA. `ancestors` lists, newest first, what `log` returns from it (itself included). */
  commits?: Record<string, CommitDetail & { committedAt?: string; ancestors?: string[] }>;
  /** `${sha}:${path}` → ranges over the whole file. */
  blame?: Record<string, BlameRange[]>;
  issues?: IssueSummary[];
  /** `${base}...${head}` → diff. */
  diffs?: Record<string, string>;
  /** `${base}...${head}` → merge base. */
  mergeBases?: Record<string, string>;
  pullCommits?: string[];
  origins?: Record<string, ReviewCommentOrigin>;
}

export type FakeHistoryMethod = "log" | "blame" | "commit" | "searchIssues";

export class FakeHistory implements HistorySource, ReplaySource {
  readonly repo: string;
  readonly calls: Array<{ method: string; query: unknown }> = [];
  readonly hang = new Set<FakeHistoryMethod>();
  private readonly data: FakeHistoryData;

  constructor(repo: string, data: FakeHistoryData = {}) {
    this.repo = repo;
    this.data = data;
  }

  private async call<T>(method: FakeHistoryMethod | string, query: unknown, answer: () => T): Promise<T> {
    this.calls.push({ method, query });
    if (this.hang.has(method as FakeHistoryMethod)) return new Promise<T>(() => {});
    return answer();
  }

  private find(sha: string): CommitDetail & { committedAt?: string; ancestors?: string[] } {
    const hit = Object.entries(this.data.commits ?? {}).find(([full]) => full.startsWith(sha));
    if (hit === undefined) throw new HistoryNotFound(`not found: commit ${sha}`);
    return hit[1];
  }

  log(q: LogQuery): Promise<CommitSummary[]> {
    return this.call("log", q, () => {
      const start = this.find(q.sha);
      const list = (start.ancestors ?? [start.sha]).map((s) => this.find(s));
      return list
        .filter((c) => q.path === undefined || c.files.some((f) => f.path === q.path || f.previousPath === q.path))
        .filter((c) => q.until === undefined || Date.parse(c.date) <= Date.parse(q.until))
        .slice(0, q.limit)
        .map(({ sha, date, author, headline }) => ({ sha, date, author, headline }));
    });
  }

  blame(q: BlameQuery): Promise<BlameRange[]> {
    return this.call("blame", q, () => {
      const ranges = this.data.blame?.[`${q.sha}:${q.path}`];
      if (ranges === undefined) throw new HistoryNotFound(`no blame for ${q.path}`);
      return ranges
        .filter((r) => r.endLine >= q.startLine && r.startLine <= q.endLine)
        .map((r) => ({ ...r, startLine: Math.max(r.startLine, q.startLine), endLine: Math.min(r.endLine, q.endLine) }));
    });
  }

  commit(q: CommitQuery): Promise<CommitDetail> {
    return this.call("commit", q, () => {
      const { ancestors: _a, ...c } = this.find(q.sha);
      return { ...c, files: c.files.filter((f) => q.path === undefined || f.path === q.path || f.previousPath === q.path) };
    });
  }

  searchIssues(q: IssueQuery): Promise<IssueSummary[]> {
    return this.call("searchIssues", q, () =>
      (this.data.issues ?? [])
        .filter((i) => q.state === "all" || i.state === q.state)
        .filter((i) => q.label === undefined || i.labels.includes(q.label))
        .filter((i) => q.createdBefore === undefined || Date.parse(i.createdAt) <= Date.parse(q.createdBefore))
        .filter((i) => q.words.every((w) => `${i.title} ${i.excerpt}`.toLowerCase().includes(w.toLowerCase())))
        .slice(0, q.limit),
    );
  }

  resolveCommit(sha: string): Promise<{ sha: string; committedAt: string }> {
    return this.call("resolveCommit", sha, () => {
      const c = this.find(sha);
      return { sha: c.sha, committedAt: c.committedAt ?? c.date };
    });
  }

  mergeBase(baseSha: string, headSha: string): Promise<string> {
    return this.call("mergeBase", { baseSha, headSha }, () => {
      const m = this.data.mergeBases?.[`${baseSha}...${headSha}`];
      if (m === undefined) throw new HistoryNotFound(`no merge base for ${baseSha}...${headSha}`);
      return m;
    });
  }

  compareDiff(baseSha: string, headSha: string): Promise<string> {
    return this.call("compareDiff", { baseSha, headSha }, () => {
      const d = this.data.diffs?.[`${baseSha}...${headSha}`];
      if (d === undefined) throw new HistoryNotFound(`no diff for ${baseSha}...${headSha}`);
      return d;
    });
  }

  pullCommits(): Promise<string[]> {
    return this.call("pullCommits", undefined, () => this.data.pullCommits ?? []);
  }

  reviewCommentOrigins(): Promise<Map<string, ReviewCommentOrigin>> {
    return this.call("reviewCommentOrigins", undefined, () => new Map(Object.entries(this.data.origins ?? {})));
  }
}
