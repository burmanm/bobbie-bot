/**
 * Minimal GitHub REST and GraphQL client for the live platform (R-2) over an
 * injectable `fetch`, so tests run against a fake without network.
 *
 * Identity (C-5): the token is a GitHub App installation token — either the
 * Actions `GITHUB_TOKEN` or a token the workflow minted for the App. The bot
 * never holds an App key and never accepts a personal access token or a
 * user-to-server token: their comments are not Bot-authored, which breaks
 * own-comment recognition (S-7), and they cannot create check runs.
 *
 * Retry (S-9): rate limits (429, 403 with an exhausted or secondary limit,
 * GraphQL `RATE_LIMITED`) wait as GitHub asks, up to a bound; transient
 * failures (5xx, network) back off exponentially. A request that may have
 * taken effect (POST) is retried only when the caller supplies a probe that
 * first looks for the effect, so a retry never posts twice.
 *
 * The token is only ever placed in the Authorization header of requests to
 * the configured API origin; it never appears in an error or a log line.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RetryOptions {
  /** Attempts per request, including the first (default 4). */
  maxAttempts?: number;
  /** Longest single wait for a rate limit; a longer reset fails fast (default 90 s). */
  maxWaitMs?: number;
  /** First backoff for transient errors, doubled per attempt (default 1 s). */
  baseDelayMs?: number;
}

export interface GitHubClientOptions {
  token: string;
  /** REST base URL (Actions: `GITHUB_API_URL`). Default https://api.github.com. */
  apiUrl?: string;
  /** GraphQL endpoint (Actions: `GITHUB_GRAPHQL_URL`). Default `<apiUrl>/graphql`. */
  graphqlUrl?: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  retry?: RetryOptions;
  /** Per-request timeout (default 60 s). */
  timeoutMs?: number;
  log?: (line: string) => void;
}

export class GitHubApiError extends Error {
  override name = "GitHubApiError";
  readonly status: number;
  readonly method: string;
  readonly path: string;
  constructor(method: string, path: string, status: number, message: string) {
    super(`GitHub ${method} ${path}: ${status === 0 ? "" : `${status} `}${message}`);
    this.status = status;
    this.method = method;
    this.path = path;
  }
}

export class RateLimitError extends GitHubApiError {
  override name = "RateLimitError";
}

export class GraphQLError extends Error {
  override name = "GraphQLError";
  /** GitHub error types, e.g. FORBIDDEN, NOT_FOUND, RATE_LIMITED. */
  readonly types: string[];
  constructor(messages: string[], types: string[]) {
    super(`GitHub GraphQL: ${messages.join("; ") || "unknown error"}${types.length ? ` (${types.join(", ")})` : ""}`);
    this.types = types;
  }
}

/** Token prefixes of user-owned credentials (C-5: not supported). */
const USER_TOKEN_PREFIXES: Array<[string, string]> = [
  ["ghp_", "a classic personal access token"],
  ["github_pat_", "a fine-grained personal access token"],
  ["gho_", "an OAuth user token"],
  ["ghu_", "a GitHub App user-to-server token"],
  ["ghr_", "a refresh token"],
];

/**
 * Refuse a token that acts as a user (C-5). Installation tokens (`ghs_`,
 * which is also what the Actions `GITHUB_TOKEN` is) pass; an unknown format
 * passes too, because GitHub Enterprise and future formats differ.
 */
export function assertInstallationToken(token: string): void {
  if (token.trim() === "") throw new Error("the GitHub token is empty");
  for (const [prefix, what] of USER_TOKEN_PREFIXES) {
    if (token.startsWith(prefix)) {
      throw new Error(
        `the GitHub token is ${what}; review-bot accepts only the Actions GITHUB_TOKEN or a GitHub App installation token, so that its comments are Bot-authored and it can create check runs (C-5)`,
      );
    }
  }
}

export interface RequestOptions<T> {
  body?: unknown;
  /** Accept header; default application/vnd.github+json. */
  accept?: string;
  /** Return the body as text instead of parsing JSON. */
  text?: boolean;
  /**
   * Safe to repeat (GET, PATCH to a fixed state, GraphQL queries). Default:
   * true for GET and PATCH, false otherwise.
   */
  idempotent?: boolean;
  /**
   * For a non-idempotent request after an ambiguous failure (5xx, network):
   * look for the effect. A defined result is returned as if the request had
   * succeeded; undefined means "not done, retry".
   */
  probe?: () => Promise<T | undefined>;
}

export interface ApiResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

const TRANSIENT = new Set([500, 502, 503, 504]);

export class GitHubClient {
  readonly apiUrl: string;
  readonly graphqlUrl: string;
  private readonly origin: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly maxWaitMs: number;
  private readonly baseDelayMs: number;
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;

  constructor(o: GitHubClientOptions) {
    assertInstallationToken(o.token);
    this.token = o.token;
    this.apiUrl = (o.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.graphqlUrl = o.graphqlUrl ?? `${this.apiUrl}/graphql`;
    const api = new URL(this.apiUrl);
    if (api.protocol !== "https:" && !(api.protocol === "http:" && ["localhost", "127.0.0.1"].includes(api.hostname))) {
      throw new Error(`GitHub API URL must be https: ${this.apiUrl}`);
    }
    this.origin = api.origin;
    if (new URL(this.graphqlUrl).origin !== this.origin) throw new Error("GitHub GraphQL URL must be on the API origin");
    this.fetchImpl = o.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? (() => Date.now());
    this.maxAttempts = Math.max(1, o.retry?.maxAttempts ?? 4);
    this.maxWaitMs = o.retry?.maxWaitMs ?? 90_000;
    this.baseDelayMs = o.retry?.baseDelayMs ?? 1_000;
    this.timeoutMs = o.timeoutMs ?? 60_000;
    this.log = o.log ?? (() => {});
  }

  private url(path: string): string {
    if (/^https?:\/\//.test(path)) {
      // Pagination links: follow only on the API origin, so the token never leaves it.
      if (new URL(path).origin !== this.origin) throw new Error(`refusing to send the token to another origin: ${new URL(path).origin}`);
      return path;
    }
    return `${this.apiUrl}/${path.replace(/^\/+/, "")}`;
  }

  /** Display form of a request path for errors and logs (no query string). */
  private static show(path: string): string {
    return path.replace(/^https?:\/\/[^/]+\/?/, "").split("?")[0]!;
  }

  async request<T>(method: string, path: string, o: RequestOptions<T> = {}): Promise<ApiResponse<T>> {
    const idempotent = o.idempotent ?? (method === "GET" || method === "PATCH");
    const url = this.url(path);
    const shown = GitHubClient.show(path);
    const headers: Record<string, string> = {
      Accept: o.accept ?? "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "User-Agent": "review-bot",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (o.body !== undefined) headers["Content-Type"] = "application/json";
    const init: RequestInit = { method, headers };
    if (o.body !== undefined) init.body = JSON.stringify(o.body);

    for (let attempt = 1; ; attempt++) {
      const last = attempt >= this.maxAttempts;
      let res: Response;
      try {
        res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        const err = new GitHubApiError(method, shown, 0, `request failed: ${reason}`);
        if (last) throw err;
        const probed = await this.ambiguous(idempotent, o.probe, err);
        if (probed !== undefined) return { status: 200, headers: new Headers(), data: probed };
        await this.backoff(attempt, `${method} ${shown} ${reason}`);
        continue;
      }

      if (res.ok) {
        const text = await res.text();
        const data = (o.text ? text : text === "" ? undefined : JSON.parse(text)) as T;
        return { status: res.status, headers: res.headers, data };
      }

      const text = await res.text().catch(() => "");
      let message = text.slice(0, 500);
      try {
        const j = JSON.parse(text) as { message?: string; errors?: Array<{ message?: string } | string> };
        const details = (j.errors ?? []).map((x) => (typeof x === "string" ? x : (x.message ?? ""))).filter((x) => x !== "");
        message = [j.message ?? "", ...details].filter((x) => x !== "").join(": ") || message;
      } catch {
        // Not JSON: keep the text.
      }

      const wait = this.rateLimitWait(res, message);
      if (wait !== undefined) {
        // The request was refused before it took effect: safe to repeat for any method.
        if (last || wait > this.maxWaitMs) {
          throw new RateLimitError(method, shown, res.status, `rate limited (${message}); retry needs ${Math.ceil(wait / 1000)} s`);
        }
        this.log(`GitHub rate limit on ${method} ${shown}; waiting ${Math.ceil(wait / 1000)} s (attempt ${attempt}/${this.maxAttempts})`);
        await this.sleep(wait);
        continue;
      }
      const err = new GitHubApiError(method, shown, res.status, message);
      if (!TRANSIENT.has(res.status) || last) throw err;
      const probed = await this.ambiguous(idempotent, o.probe, err);
      if (probed !== undefined) return { status: 200, headers: new Headers(), data: probed };
      await this.backoff(attempt, `${method} ${shown} ${res.status}`);
    }
  }

  /** After an ambiguous failure: may the request be repeated? Returns the probed result, if any. */
  private async ambiguous<T>(idempotent: boolean, probe: (() => Promise<T | undefined>) | undefined, err: Error): Promise<T | undefined> {
    if (idempotent) return undefined;
    if (probe === undefined) throw err;
    return probe();
  }

  private async backoff(attempt: number, what: string): Promise<void> {
    const ms = this.baseDelayMs * 2 ** (attempt - 1);
    this.log(`GitHub transient failure (${what}); retrying in ${Math.ceil(ms / 1000)} s (attempt ${attempt}/${this.maxAttempts})`);
    await this.sleep(ms);
  }

  /** Milliseconds to wait when the response is a rate limit, else undefined. */
  private rateLimitWait(res: Response, message: string): number | undefined {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const secondary = /secondary rate limit|abuse detection/i.test(message);
    const primary = remaining === "0" && (res.status === 403 || res.status === 429);
    if (res.status !== 429 && !primary && !(res.status === 403 && secondary)) return undefined;
    const after = Number(res.headers.get("retry-after"));
    if (Number.isFinite(after) && after > 0) return after * 1000;
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (primary && Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - this.now()) + 1000;
    // GitHub: without retry-after, wait at least a minute for a secondary limit.
    return 60_000;
  }

  async get<T>(path: string, o: RequestOptions<T> = {}): Promise<T> {
    return (await this.request<T>("GET", path, o)).data;
  }

  /** All items of a list endpoint, following `Link: rel="next"` (bounded). */
  async paginate<T>(path: string, maxPages = 100): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    for (let page = 0; next !== undefined; page++) {
      if (page >= maxPages) throw new Error(`GitHub ${GitHubClient.show(path)}: more than ${maxPages} pages`);
      const res: ApiResponse<T[]> = await this.request<T[]>("GET", next);
      out.push(...(res.data ?? []));
      next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1];
    }
    return out;
  }

  /**
   * A GraphQL request. Queries are idempotent; a mutation is idempotent
   * only when the caller says so (resolving a resolved thread is a no-op).
   */
  async graphql<T>(query: string, variables: Record<string, unknown>, o: { idempotent?: boolean } = {}): Promise<T> {
    const idempotent = o.idempotent ?? !/^\s*mutation\b/.test(query);
    for (let attempt = 1; ; attempt++) {
      const res = await this.request<{ data?: T; errors?: Array<{ message?: string; type?: string }> }>("POST", this.graphqlUrl, {
        body: { query, variables },
        idempotent,
      });
      const errors = res.data?.errors ?? [];
      if (errors.length === 0 && res.data?.data !== undefined) return res.data.data;
      const types = errors.map((e) => e.type ?? "").filter((t) => t !== "");
      if (types.includes("RATE_LIMITED") && attempt < this.maxAttempts) {
        this.log(`GitHub GraphQL rate limit; waiting 60 s (attempt ${attempt}/${this.maxAttempts})`);
        await this.sleep(Math.min(60_000, this.maxWaitMs));
        continue;
      }
      throw new GraphQLError(
        errors.map((e) => e.message ?? "").filter((m) => m !== ""),
        types,
      );
    }
  }
}

/**
 * A client from the environment: `GITHUB_TOKEN` (the Actions token, or an
 * App installation token the workflow put there), `GITHUB_API_URL`,
 * `GITHUB_GRAPHQL_URL`.
 */
export function gitHubClientFromEnv(
  env: Record<string, string | undefined>,
  o: Omit<GitHubClientOptions, "token" | "apiUrl" | "graphqlUrl"> = {},
): GitHubClient {
  const token = env.GITHUB_TOKEN;
  if (token === undefined || token.trim() === "") {
    throw new Error("GITHUB_TOKEN is not set: give the Actions GITHUB_TOKEN or a GitHub App installation token (C-5)");
  }
  return new GitHubClient({
    ...o,
    token: token.trim(),
    ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}),
    ...(env.GITHUB_GRAPHQL_URL ? { graphqlUrl: env.GITHUB_GRAPHQL_URL } : {}),
  });
}
