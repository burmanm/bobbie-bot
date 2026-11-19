/**
 * The few GitHub REST calls the CI jobs make outside the review pipeline
 * (C-4 gate, S-9 always-run check completion, C-4 label removal).
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
}

export interface CheckRunOutput {
  title: string;
  summary: string;
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

  async getPull(number: number): Promise<PullSummary> {
    const pr = (await this.json<{
      number: number;
      state: string;
      draft?: boolean;
      user?: { login?: string; type?: string } | null;
      labels?: Array<{ name?: string }>;
      head: { sha: string };
      base: { sha: string };
    }>("GET", `${this.base()}/pulls/${number}`))!;
    return {
      number: pr.number,
      state: pr.state === "open" ? "open" : "closed",
      draft: pr.draft === true,
      author: { login: pr.user?.login ?? "ghost", type: pr.user?.type ?? "User" },
      labels: (pr.labels ?? []).map((l) => l.name ?? "").filter((n) => n !== ""),
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
    };
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
      output,
    });
    return r!.id;
  }

  /** Check runs called `name` on `sha`, newest first. */
  async listChecks(sha: string, name: string): Promise<CheckRunSummary[]> {
    const r = await this.json<{ check_runs?: Array<{ id: number; status: string; conclusion: string | null; app?: { slug?: string } | null }> }>(
      "GET",
      `${this.base()}/commits/${encodeURIComponent(sha)}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest&per_page=100`,
    );
    return (r?.check_runs ?? []).map((c) => ({ id: c.id, status: c.status, conclusion: c.conclusion, ...(c.app?.slug ? { app: c.app.slug } : {}) }));
  }

  async completeCheck(id: number, conclusion: string, output: CheckRunOutput): Promise<void> {
    await this.json("PATCH", `${this.base()}/check-runs/${id}`, {
      status: "completed",
      conclusion,
      completed_at: new Date().toISOString(),
      output,
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
