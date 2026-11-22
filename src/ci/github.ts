/**
 * The few GitHub REST calls the CI jobs make outside the review pipeline
 * (C-4 gate, C-9 waiting for CI, S-9 always-run check completion, C-4
 * label removal).
 *
 * Deliberately small and separate from `src/platform/`: the gate runs
 * before any snapshot exists and needs calls the `Platform` interface does
 * not have (permissions, issue events, raw file at a SHA, label removal).
 * When the live platform exports a standalone check-run completion, the
 * check-run calls here can move to it.
 *
 * The token is held by this object only. It is never logged and never
 * appears in an error message.
 */
import { safeSummary } from "../core/index.ts";

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface GithubOptions {
  token: string;
  /** owner/name */
  repo: string;
  apiUrl?: string;
  fetch?: Fetch;
}

export interface PullSummary {
  number: number;
  state: "open" | "closed";
  draft: boolean;
  author: { login: string; type: string };
  labels: string[];
  headSha: string;
  baseSha: string;
  /** Base branch name (C-9 `required` reads its protection). */
  baseRef: string;
}

export interface LabelEvent {
  event: "labeled" | "unlabeled";
  label: string;
  actor: string;
  createdAt: string;
}

export interface CheckRunSummary {
  id: number;
  status: string;
  conclusion: string | null;
  app?: string;
  startedAt?: string;
}

interface PullJson {
  number: number;
  state: string;
  draft?: boolean;
  user?: { login?: string; type?: string } | null;
  labels?: Array<{ name?: string }>;
  head: { sha: string };
  base: { sha: string; ref?: string };
}

function pullSummary(pr: PullJson): PullSummary {
  return {
    number: pr.number,
    state: pr.state === "open" ? "open" : "closed",
    draft: pr.draft === true,
    author: { login: pr.user?.login ?? "ghost", type: pr.user?.type ?? "User" },
    labels: (pr.labels ?? []).map((l) => l.name ?? "").filter((n) => n !== ""),
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    baseRef: pr.base.ref ?? "",
  };
}

/** Pages read at most by one list call (100 items each). */
const MAX_PAGES = 30;

export interface CheckRunOutput {
  title: string;
  summary: string;
}

/** GitHub renders the summary as Markdown, and check names in it come from the PR (H-51). */
function safeOutput(o: CheckRunOutput): CheckRunOutput {
  return { title: o.title, summary: safeSummary(o.summary) };
}

export class GithubError extends Error {
  override name = "GithubError";
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** One entry of a git tree (GitHub's recursive tree listing). */
export interface TreeEntry {
  path: string;
  /** 100644, 100755, 120000 (symlink), 040000 (tree), 160000 (submodule). */
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

/** Repository permission levels that count as "maintainer" (C-4: write access or above). */
export const MAINTAINER_ROLES = ["admin", "maintain", "write"] as const;

export class Github {
  private readonly token: string;
  readonly repo: string;
  private readonly apiUrl: string;
  private readonly fetch: Fetch;

  constructor(o: GithubOptions) {
    if (!REPO.test(o.repo)) throw new Error(`invalid repository: ${o.repo}`);
    if (o.token === "") throw new Error("no GitHub token: set GH_TOKEN");
    this.token = o.token;
    this.repo = o.repo;
    this.apiUrl = (o.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetch = o.fetch ?? (globalThis.fetch as unknown as Fetch);
  }

  private async call(method: string, path: string, body?: unknown, accept = "application/vnd.github+json") {
    const absolute = path.startsWith("https://") || path.startsWith("http://");
    // A pagination link must stay on the API host: the token goes with it.
    if (absolute && !path.startsWith(`${this.apiUrl}/`)) throw new Error(`refusing to send the token to ${new URL(path).host}`);
    const url = absolute ? path : `${this.apiUrl}${path}`;
    const init: { method: string; headers: Record<string, string>; body?: string } = {
      method,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "review-bot",
      },
    };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await this.fetch(url, init);
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown, okMissing = false): Promise<T | undefined> {
    const res = await this.call(method, path, body);
    if (okMissing && res.status === 404) return undefined;
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      let message = "";
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? "";
      } catch {
        message = "";
      }
      throw new GithubError(`${method} ${path.replace(/\?.*$/, "")}: HTTP ${res.status}${message ? ` ${message}` : ""}`, res.status);
    }
    return text === "" ? (undefined as T) : (JSON.parse(text) as T);
  }

  private base(): string {
    return `/repos/${this.repo}`;
  }

  /**
   * GET every page of a list. `pick` takes the items out of one page (an
   * array, or the array inside an object such as `check_runs`).
   */
  private async pages<T>(path: string, pick: (page: unknown) => T[] | undefined): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;
    for (let page = 0; next !== undefined && page < MAX_PAGES; page++) {
      const res = await this.call("GET", next);
      const text = await res.text();
      if (res.status !== 200) {
        let message = "";
        try {
          message = (JSON.parse(text) as { message?: string }).message ?? "";
        } catch {
          message = "";
        }
        throw new GithubError(`GET ${next.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "")}: HTTP ${res.status}${message ? ` ${message}` : ""}`, res.status);
      }
      out.push(...(pick(JSON.parse(text) as unknown) ?? []));
      next = nextLink(res.headers.get("link"));
    }
    return out;
  }

  async getPull(number: number): Promise<PullSummary> {
    return pullSummary((await this.json<PullJson>("GET", `${this.base()}/pulls/${number}`))!);
  }

  /** Open PRs, oldest first (C-9: a `workflow_run` or `status` event names only a SHA). */
  async listOpenPulls(): Promise<PullSummary[]> {
    const all = await this.pages<PullJson>(`${this.base()}/pulls?state=open&sort=created&direction=asc&per_page=100`, (p) => p as PullJson[]);
    return all.map(pullSummary);
  }

  /**
   * Required status checks of classic branch protection, as the branch
   * reports them to any reader (`protection.required_status_checks`).
   */
  async getBranchRequiredChecks(branch: string): Promise<string[]> {
    const b = await this.json<{
      protection?: { required_status_checks?: { contexts?: string[]; checks?: Array<{ context?: string }> } | null } | null;
    }>("GET", `${this.base()}/branches/${branch.split("/").map(encodeURIComponent).join("/")}`, undefined, true);
    const r = b?.protection?.required_status_checks;
    if (!r) return [];
    return [...(r.contexts ?? []), ...(r.checks ?? []).map((c) => c.context ?? "")].filter((n) => n !== "");
  }

  /** Required status checks from rulesets that apply to the branch. */
  async getRulesetRequiredChecks(branch: string): Promise<string[]> {
    const rules = await this.pages<{ type?: string; parameters?: { required_status_checks?: Array<{ context?: string }> } }>(
      `${this.base()}/rules/branches/${branch.split("/").map(encodeURIComponent).join("/")}?per_page=100`,
      (p) => p as never,
    ).catch((e: unknown) => {
      if (e instanceof GithubError && e.status === 404) return [];
      throw e;
    });
    return rules
      .filter((r) => r.type === "required_status_checks")
      .flatMap((r) => (r.parameters?.required_status_checks ?? []).map((c) => c.context ?? ""))
      .filter((n) => n !== "");
  }

  /** Every check run on the SHA (the latest of each), any name. */
  async listCheckRuns(sha: string): Promise<Array<{ name: string; status: string; conclusion: string | null; completedAt?: string }>> {
    const runs = await this.pages<{ name: string; status: string; conclusion: string | null; completed_at?: string | null }>(
      `${this.base()}/commits/${encodeURIComponent(sha)}/check-runs?filter=latest&per_page=100`,
      (p) => (p as { check_runs?: never[] }).check_runs,
    );
    return runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, ...(r.completed_at ? { completedAt: r.completed_at } : {}) }));
  }

  /** The latest commit status of each context on the SHA. */
  async listStatuses(sha: string): Promise<Array<{ context: string; state: string; updatedAt?: string }>> {
    const statuses = await this.pages<{ context: string; state: string; updated_at?: string }>(
      `${this.base()}/commits/${encodeURIComponent(sha)}/status?per_page=100`,
      (p) => (p as { statuses?: never[] }).statuses,
    );
    return statuses.map((s) => ({ context: s.context, state: s.state, ...(s.updated_at ? { updatedAt: s.updated_at } : {}) }));
  }

  /** Workflow runs for the SHA (needs `actions: read`). */
  async listWorkflowRuns(sha: string): Promise<Array<{ id: number; name: string; status: string; conclusion: string | null; updatedAt?: string }>> {
    const runs = await this.pages<{ id: number; name?: string | null; status: string; conclusion: string | null; updated_at?: string }>(
      `${this.base()}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`,
      (p) => (p as { workflow_runs?: never[] }).workflow_runs,
    );
    return runs.map((r) => ({ id: r.id, name: r.name ?? "", status: r.status, conclusion: r.conclusion, ...(r.updated_at ? { updatedAt: r.updated_at } : {}) }));
  }

  /**
   * The user's role on this repository: admin, maintain, write, triage,
   * read, or none (also for users and apps the API does not know).
   * The permissions API, not `author_association`, which is unreliable when
   * organization membership is private (C-4).
   */
  async getRole(login: string): Promise<string> {
    const r = await this.json<{ permission?: string; role_name?: string }>(
      "GET",
      `${this.base()}/collaborators/${encodeURIComponent(login)}/permission`,
      undefined,
      true,
    );
    if (r === undefined) return "none";
    return r.role_name ?? r.permission ?? "none";
  }

  async isMaintainer(login: string): Promise<boolean> {
    return (MAINTAINER_ROLES as readonly string[]).includes(await this.getRole(login));
  }

  /** `labeled` / `unlabeled` events on the PR, oldest first, all pages. */
  async listLabelEvents(number: number): Promise<LabelEvent[]> {
    const out: LabelEvent[] = [];
    let path: string | undefined = `${this.base()}/issues/${number}/events?per_page=100`;
    for (let page = 0; path !== undefined && page < 50; page++) {
      const res = await this.call("GET", path);
      const text = await res.text();
      if (res.status !== 200) throw new GithubError(`GET issue events: HTTP ${res.status}`, res.status);
      const items = JSON.parse(text) as Array<{ event?: string; label?: { name?: string }; actor?: { login?: string } | null; created_at?: string }>;
      for (const e of items) {
        if ((e.event === "labeled" || e.event === "unlabeled") && e.label?.name) {
          out.push({ event: e.event, label: e.label.name, actor: e.actor?.login ?? "ghost", createdAt: e.created_at ?? "" });
        }
      }
      path = nextLink(res.headers.get("link"));
    }
    return out;
  }

  /** The default branch and the commit it points at now. */
  async getDefaultBranchHead(): Promise<{ branch: string; sha: string }> {
    const repo = await this.json<{ default_branch?: unknown }>("GET", this.base());
    const branch = repo?.default_branch;
    if (typeof branch !== "string" || branch === "") throw new Error(`${this.repo}: no default branch`);
    const commit = await this.json<{ sha?: unknown }>("GET", `${this.base()}/commits/${encodeURIComponent(branch)}`);
    if (typeof commit?.sha !== "string" || !/^[0-9a-f]{40}$/.test(commit.sha)) throw new Error(`${this.repo}: cannot resolve ${branch}`);
    return { branch, sha: commit.sha };
  }

  /** Every entry of the commit's tree. Refuses a tree GitHub truncated. */
  async getTree(commitSha: string): Promise<TreeEntry[]> {
    const tree = await this.json<{ tree?: TreeEntry[]; truncated?: boolean }>("GET", `${this.base()}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`);
    if (tree?.truncated === true) throw new Error(`${this.repo}@${commitSha}: the tree is too large to list`);
    return tree?.tree ?? [];
  }

  /** A blob's bytes. */
  async getBlob(sha: string): Promise<Buffer> {
    const blob = await this.json<{ content?: unknown; encoding?: unknown }>("GET", `${this.base()}/git/blobs/${encodeURIComponent(sha)}`);
    if (blob?.encoding !== "base64" || typeof blob.content !== "string") throw new Error(`blob ${sha}: unexpected encoding`);
    return Buffer.from(blob.content, "base64");
  }

  /** A file's text at `ref`, or undefined when it does not exist. */
  async getFile(path: string, ref: string): Promise<string | undefined> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const res = await this.call("GET", `${this.base()}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, undefined, "application/vnd.github.raw+json");
    if (res.status === 404) return undefined;
    const text = await res.text();
    if (res.status !== 200) throw new GithubError(`GET contents/${path}: HTTP ${res.status}`, res.status);
    return text;
  }

  async createCompletedCheck(name: string, headSha: string, conclusion: string, output: CheckRunOutput): Promise<number> {
    const r = await this.json<{ id: number }>("POST", `${this.base()}/check-runs`, {
      name,
      head_sha: headSha,
      status: "completed",
      conclusion,
      completed_at: new Date().toISOString(),
      output: safeOutput(output),
    });
    return r!.id;
  }

  /**
   * C-9: `ai-review/<name>` as *queued* while the PR waits for CI. Its
   * `started_at` is when the bot first saw the head SHA; the sweep times
   * the wait from it.
   */
  async createQueuedCheck(name: string, headSha: string, output: CheckRunOutput, startedAt: string): Promise<number> {
    const r = await this.json<{ id: number }>("POST", `${this.base()}/check-runs`, { name, head_sha: headSha, status: "queued", started_at: startedAt, output: safeOutput(output) });
    return r!.id;
  }

  /** Changes an open check run's status and text (not its conclusion). */
  async updateCheck(id: number, status: "queued" | "in_progress", output: CheckRunOutput): Promise<void> {
    await this.json("PATCH", `${this.base()}/check-runs/${id}`, { status, output: safeOutput(output) });
  }

  /** Check runs called `name` on `sha`, newest first. */
  async listChecks(sha: string, name: string): Promise<CheckRunSummary[]> {
    const r = await this.json<{
      check_runs?: Array<{ id: number; status: string; conclusion: string | null; started_at?: string | null; app?: { slug?: string } | null }>;
    }>("GET", `${this.base()}/commits/${encodeURIComponent(sha)}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest&per_page=100`);
    return (r?.check_runs ?? [])
      .map((c) => ({ id: c.id, status: c.status, conclusion: c.conclusion, ...(c.app?.slug ? { app: c.app.slug } : {}), ...(c.started_at ? { startedAt: c.started_at } : {}) }))
      .sort((a, b) => b.id - a.id);
  }

  async completeCheck(id: number, conclusion: string, output: CheckRunOutput): Promise<void> {
    await this.json("PATCH", `${this.base()}/check-runs/${id}`, {
      status: "completed",
      conclusion,
      completed_at: new Date().toISOString(),
      output: safeOutput(output),
    });
  }

  /** Removes a label from the PR. A label that is already gone is not an error. */
  async removeLabel(number: number, label: string): Promise<boolean> {
    const res = await this.call("DELETE", `${this.base()}/issues/${number}/labels/${encodeURIComponent(label)}`);
    await res.text();
    if (res.status === 404) return false;
    if (res.status < 200 || res.status >= 300) throw new GithubError(`DELETE label: HTTP ${res.status}`, res.status);
    return true;
  }
}

/** The `rel="next"` URL of a Link header (the caller refuses one on another host). */
export function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return undefined;
}
