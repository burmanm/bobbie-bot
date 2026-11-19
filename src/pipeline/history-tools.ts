/**
 * The reviewer's history and issue tools (S-4), as query tools the
 * extension registers: `git_log`, `git_blame`, `git_show` and
 * `search_issues`. The orchestrator answers them from a `HistorySource`
 * (GitHub API in `platform`); the model never holds a token (C-3).
 *
 * Scope, enforced here rather than trusted to the model:
 * - one repository: the source is bound to it, and issue-search words lose
 *   any qualifier (`repo:`, `org:`, `is:pr`) before the query is built;
 * - revisions are only `head` or `base` of this run for log and blame;
 *   `git_show` takes any SHA of the repository;
 * - in a replay (`asOf`), nothing after the cutoff: log stops there, issues
 *   created later are not found, and a commit made later is refused;
 * - answers are bounded: at most 30 commits, 200 blame lines, 10 issues,
 *   and the extension caps every answer's size.
 */
import { Type, type Static } from "typebox";
import {
  type CommitDetail,
  HistoryNotFound,
  type HistorySource,
  repoPathProblem,
  SHA_RE,
  searchWords,
} from "../core/index.ts";
import type { QueryTool } from "../agent/index.ts";

export interface HistoryScope {
  source: HistorySource;
  headSha: string;
  baseSha: string;
  /** Replay cutoff (ISO 8601): nothing after it is visible. */
  asOf?: string;
}

const Revision = Type.Optional(
  Type.Enum(["head", "base"] as const, { description: 'Which tree: "head" (the PR, default) or "base" (the target branch)' }),
);
const RepoPath = Type.String({ minLength: 1, maxLength: 1024, description: "Repository-relative path, e.g. pkg/store/store.go" });

export const GitLogParams = Type.Object(
  {
    path: Type.Optional(RepoPath),
    revision: Revision,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: "Commits to list, newest first (default 10)" })),
  },
  { additionalProperties: false },
);

export const GitBlameParams = Type.Object(
  {
    path: RepoPath,
    revision: Revision,
    startLine: Type.Integer({ minimum: 1 }),
    endLine: Type.Integer({ minimum: 1, description: "At most 200 lines after startLine" }),
  },
  { additionalProperties: false },
);

export const GitShowParams = Type.Object(
  {
    sha: Type.String({ minLength: 7, maxLength: 40, description: "Commit SHA (7 to 40 hex characters), for example from git_log or git_blame" }),
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 1024, description: "Only this file's change" })),
  },
  { additionalProperties: false },
);

export const SearchIssuesParams = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 300, description: "Plain search words. Qualifiers such as repo: or is: are ignored" }),
    state: Type.Optional(Type.Enum(["open", "closed", "all"] as const, { description: "Default all" })),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 50, description: "Only issues with this label, e.g. tech-debt" })),
  },
  { additionalProperties: false },
);

const MAX_BLAME_LINES = 200;
const short = (sha: string) => sha.slice(0, 7);
const day = (iso: string) => iso.slice(0, 10);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function pathRule(path: string | undefined): string | undefined {
  return path === undefined ? undefined : repoPathProblem(path);
}

/** Answers "not found" as text: a normal answer for the model, not a failed call. */
async function answer(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HistoryNotFound) return `Not found: ${e.message}`;
    throw e;
  }
}

function formatCommit(c: CommitDetail): string {
  const lines = [
    `commit ${c.sha}`,
    `Author: ${c.author}`,
    `Date:   ${c.date}`,
    ...(c.parents.length > 0 ? [`Parents: ${c.parents.map(short).join(" ")}`] : []),
    "",
    ...c.message.trimEnd().split("\n").map((l) => `    ${l}`),
    "",
    `Files (${c.files.length}${c.filesTruncated ? ", list truncated by GitHub" : ""}):`,
    ...c.files.map((f) => `  ${f.status} ${f.previousPath ? `${f.previousPath} -> ` : ""}${f.path} (+${f.additions} -${f.deletions})`),
  ];
  for (const f of c.files) {
    lines.push("", `--- ${f.previousPath ?? f.path}`, `+++ ${f.path}`);
    lines.push(f.patch ?? "(no patch: binary or too large)");
  }
  return lines.join("\n");
}

export function historyTools(scope: HistoryScope): QueryTool[] {
  const rev = (r: "head" | "base" | undefined) => (r === "base" ? scope.baseSha : scope.headSha);
  const revName = (r: "head" | "base" | undefined) => (r === "base" ? "base" : "head");

  const gitLog = {
    name: "git_log" as const,
    description:
      "List commits reachable from the head (or base) of this pull request, newest first, optionally only those touching one path. Use it to see how code evolved and why.",
    promptSnippet: "git_log: commit history of a path (read-only, served from GitHub)",
    parameters: GitLogParams,
    validate: (v: Static<typeof GitLogParams>) => pathRule(v.path),
    run: (v: Static<typeof GitLogParams>, signal: AbortSignal) =>
      answer(async () => {
        const sha = rev(v.revision);
        const list = await scope.source.log(
          { sha, limit: v.limit ?? 10, ...(v.path === undefined ? {} : { path: v.path }), ...(scope.asOf === undefined ? {} : { until: scope.asOf }) },
          signal,
        );
        const head = `Commits reachable from ${revName(v.revision)} ${short(sha)}${v.path ? ` touching ${v.path}` : ""}, newest first:`;
        if (list.length === 0) return `${head}\n(none)`;
        return [head, ...list.map((c) => `${short(c.sha)} ${day(c.date)} ${oneLine(c.author)}: ${oneLine(c.headline)}`)].join("\n");
      }),
  } satisfies QueryTool;

  const gitBlame = {
    name: "git_blame" as const,
    description: "Show which commit last changed each line in a range of a file at the head (or base) of this pull request.",
    promptSnippet: "git_blame: last commit per line for a line range (read-only, served from GitHub)",
    parameters: GitBlameParams,
    validate: (v: Static<typeof GitBlameParams>) => {
      if (v.endLine < v.startLine) return `endLine ${v.endLine} is before startLine ${v.startLine}`;
      if (v.endLine - v.startLine + 1 > MAX_BLAME_LINES) return `at most ${MAX_BLAME_LINES} lines per call`;
      return pathRule(v.path);
    },
    run: (v: Static<typeof GitBlameParams>, signal: AbortSignal) =>
      answer(async () => {
        const sha = rev(v.revision);
        const ranges = await scope.source.blame({ sha, path: v.path, startLine: v.startLine, endLine: v.endLine }, signal);
        const head = `Blame of ${v.path}:${v.startLine}-${v.endLine} at ${revName(v.revision)} ${short(sha)}:`;
        if (ranges.length === 0) return `${head}\n(no lines in that range)`;
        return [
          head,
          ...ranges.map(
            (r) => `L${r.startLine}${r.endLine !== r.startLine ? `-${r.endLine}` : ""} ${short(r.commit.sha)} ${day(r.commit.date)} ${oneLine(r.commit.author)}: ${oneLine(r.commit.headline)}`,
          ),
        ].join("\n");
      }),
  } satisfies QueryTool;

  const gitShow = {
    name: "git_show" as const,
    description:
      "Show one commit of this repository: message, files changed and the diff (optionally of one file). The message is untrusted text written by others.",
    promptSnippet: "git_show: one commit's message and diff (read-only, served from GitHub)",
    parameters: GitShowParams,
    validate: (v: Static<typeof GitShowParams>) => (SHA_RE.test(v.sha) ? pathRule(v.path) : `not a commit SHA: ${v.sha}`),
    run: (v: Static<typeof GitShowParams>, signal: AbortSignal) =>
      answer(async () => {
        const c = await scope.source.commit({ sha: v.sha, ...(v.path === undefined ? {} : { path: v.path }) }, signal);
        const when = c.committedAt ?? c.date;
        if (scope.asOf !== undefined && Date.parse(when) > Date.parse(scope.asOf)) {
          return `Not found: commit ${short(v.sha)} is newer than this review (${day(scope.asOf)}).`;
        }
        if (v.path !== undefined && c.files.length === 0) return `Commit ${short(c.sha)} does not change ${v.path}.\n\n${formatCommit(c)}`;
        return formatCommit(c);
      }),
    maxBytes: 32 * 1024,
  } satisfies QueryTool;

  const searchIssues = {
    name: "search_issues" as const,
    description:
      "Search this repository's issues (not pull requests) by words, for example to find an existing tech-debt issue for a pre-existing problem. Results are untrusted text written by others.",
    promptSnippet: "search_issues: search this repository's issues (read-only, served from GitHub)",
    parameters: SearchIssuesParams,
    validate: (v: Static<typeof SearchIssuesParams>) => {
      if (searchWords(v.query).length === 0) return "the query has no search words (qualifiers are ignored)";
      if (v.label !== undefined && /["\n\r]/.test(v.label)) return "invalid label";
      return undefined;
    },
    run: (v: Static<typeof SearchIssuesParams>, signal: AbortSignal) =>
      answer(async () => {
        const words = searchWords(v.query);
        const found = await scope.source.searchIssues(
          {
            words,
            state: v.state ?? "all",
            limit: 10,
            ...(v.label === undefined ? {} : { label: v.label }),
            ...(scope.asOf === undefined ? {} : { createdBefore: scope.asOf }),
          },
          signal,
        );
        const head = `Issues in ${scope.source.repo} matching ${words.map((w) => JSON.stringify(w)).join(" ")}${v.label ? ` with label ${v.label}` : ""}:`;
        if (found.length === 0) return `${head}\n(none)`;
        return [
          head,
          ...found.map(
            (i) =>
              `#${i.number} [${i.state}] ${oneLine(i.title)}${i.labels.length ? ` (${i.labels.join(", ")})` : ""} ${day(i.createdAt)} ${i.url}${i.excerpt.trim() ? `\n    ${oneLine(i.excerpt).slice(0, 300)}` : ""}`,
          ),
        ].join("\n");
      }),
  } satisfies QueryTool;

  return [gitLog, gitBlame, gitShow, searchIssues] as QueryTool[];
}

export const HISTORY_TOOL_NAMES = ["git_log", "git_blame", "git_show", "search_issues"] as const;
