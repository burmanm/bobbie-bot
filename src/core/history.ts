/**
 * Repository history and issue queries (S-4): the shapes the orchestrator
 * answers the reviewer's history tools with. There is no `.git` in a
 * snapshot, so the answers come from the code host's API; the source is
 * implemented in `platform` and the tools in `pipeline`. Pure types and
 * input checks: no I/O here (A-2).
 *
 * Every query is scoped to one repository by the source itself. The model
 * names only a revision ("head", "base" or a commit SHA), a path inside the
 * repository and plain search words.
 */

export interface CommitSummary {
  sha: string;
  /** ISO 8601, author date. */
  date: string;
  author: string;
  /** First line of the message. */
  headline: string;
}

export interface CommitFile {
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  /** Absent for binary files and patches the host does not return (too large). */
  patch?: string;
}

export interface CommitDetail extends CommitSummary {
  /** ISO 8601, committer date, when known. Replays refuse commits made after their cutoff. */
  committedAt?: string;
  /** Full message. Untrusted. */
  message: string;
  parents: string[];
  files: CommitFile[];
  /** True when the host returned only part of the file list. */
  filesTruncated?: boolean;
}

export interface BlameRange {
  startLine: number;
  endLine: number;
  commit: CommitSummary;
}

export interface IssueSummary {
  number: number;
  title: string;
  state: "open" | "closed";
  labels: string[];
  url: string;
  createdAt: string;
  /** Start of the body, untrusted. */
  excerpt: string;
}

export interface LogQuery {
  /** Full commit SHA the log starts from. */
  sha: string;
  path?: string;
  limit: number;
  /** Only commits authored at or before this time (replays). */
  until?: string;
}

export interface BlameQuery {
  sha: string;
  path: string;
  startLine: number;
  endLine: number;
}

export interface CommitQuery {
  sha: string;
  /** Only this file's patch. */
  path?: string;
}

export interface IssueQuery {
  /** Plain words; qualifiers are removed before the query is sent. */
  words: string[];
  state: "open" | "closed" | "all";
  label?: string;
  limit: number;
  /** Only issues created at or before this time (replays). */
  createdBefore?: string;
}

/**
 * Read-only history of one repository. Implementations hold whatever
 * credential they need; nothing in a result carries it. Methods should stop
 * when `signal` aborts.
 */
export interface HistorySource {
  readonly repo: string;
  log(q: LogQuery, signal?: AbortSignal): Promise<CommitSummary[]>;
  blame(q: BlameQuery, signal?: AbortSignal): Promise<BlameRange[]>;
  commit(q: CommitQuery, signal?: AbortSignal): Promise<CommitDetail>;
  searchIssues(q: IssueQuery, signal?: AbortSignal): Promise<IssueSummary[]>;
}

/** A query the source could not answer because the thing does not exist (unknown SHA, path). */
export class HistoryNotFound extends Error {
  override name = "HistoryNotFound";
}

export const SHA_RE = /^[0-9a-f]{7,40}$/;
export const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * A repository-relative path the model may name: no absolute path, no `..`
 * or `.` segment, no backslash, no control character, not empty. Returns a
 * reason when it is not one.
 */
export function repoPathProblem(path: string): string | undefined {
  if (path.length === 0) return "path is empty";
  if (path.length > 1024) return "path is too long";
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return "path contains a control character or a backslash";
  if (path.startsWith("/")) return "path must be relative to the repository root";
  const segs = path.replace(/\/+$/, "").split("/");
  if (segs.some((s) => s === ".." || s === "." || s === "")) return "path must not contain empty, '.' or '..' segments";
  return undefined;
}

/**
 * Words for an issue search: qualifiers (`repo:x`, `is:pr`, `org:y`) and
 * search operators are dropped so a query cannot leave the repository or
 * change its meaning; quotes are removed. At most 12 words of 50 characters.
 */
export function searchWords(text: string): string[] {
  return text
    .split(/\s+/)
    .map((w) => w.replace(/["'`]/g, ""))
    .filter((w) => w !== "" && !w.includes(":") && !/^(AND|OR|NOT)$/.test(w) && !w.startsWith("-"))
    .map((w) => w.slice(0, 50))
    .slice(0, 12);
}
