/** A scripted GitHub REST API for the CI tests. No network. */
import type { Fetch } from "./github.ts";

export interface FakeRepo {
  pulls: Record<number, {
    number: number;
    state?: string;
    draft?: boolean;
    user: { login: string; type?: string };
    labels: string[];
    head: string;
    base: string;
    baseRef?: string;
  }>;
  /** login → role_name; anything missing is a 404. */
  roles: Record<string, string>;
  /** PR number → label events, oldest first. */
  events?: Record<number, Array<{ event: string; label: string; actor: string }>>;
  /** "path@ref" → text */
  files?: Record<string, string>;
  checks?: Array<{
    id: number;
    name: string;
    head_sha: string;
    status: string;
    conclusion: string | null;
    app?: string;
    started_at?: string;
    completed_at?: string;
    output?: { title: string; summary: string };
  }>;
  /** Branch → required contexts of classic branch protection. */
  protection?: Record<string, string[]>;
  /** Branch → required contexts from rulesets. */
  rulesets?: Record<string, string[]>;
  statuses?: Array<{ sha: string; context: string; state: string; updated_at?: string }>;
  workflowRuns?: Array<{ id: number; head_sha: string; name: string; status: string; conclusion: string | null; updated_at?: string }>;
  /** Endpoints (path prefixes) that answer 403, e.g. "/actions/runs". */
  forbidden?: string[];
  /** Check run ids whose update is refused (created by another identity). */
  foreignChecks?: number[];
  /** The default branch and its head commit. */
  defaultBranch?: { name: string; sha: string };
  /** Commit SHA → recursive tree listing. */
  trees?: Record<string, Array<{ path: string; mode: string; type: string; sha: string; size?: number }>>;
  /** Blob SHA → content. */
  blobs?: Record<string, string>;
}

export interface Call {
  method: string;
  path: string;
  body?: unknown;
  auth?: string;
}

export function fakeGithub(repo: FakeRepo, eventsPerPage = 100): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  let nextCheck = 1000;
  const fetch: Fetch = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "");
    const body = init.body === undefined ? undefined : (JSON.parse(init.body) as unknown);
    calls.push({ method: init.method, path: `${path}${u.search}`, ...(body === undefined ? {} : { body }), ...(init.headers.Authorization ? { auth: init.headers.Authorization } : {}) });
    const reply = (status: number, data?: unknown, headers: Record<string, string> = {}) => ({
      status,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      text: async () => (data === undefined ? "" : typeof data === "string" ? data : JSON.stringify(data)),
    });
    let m: RegExpExecArray | null;
    if (repo.forbidden?.some((f) => path.startsWith(f))) return reply(403, { message: "Resource not accessible by integration" });
    const pullJson = (p: FakeRepo["pulls"][number]) => ({
      number: p.number,
      state: p.state ?? "open",
      draft: p.draft ?? false,
      user: { login: p.user.login, type: p.user.type ?? "User" },
      labels: p.labels.map((name) => ({ name })),
      head: { sha: p.head },
      base: { sha: p.base, ref: p.baseRef ?? "main" },
    });
    if (init.method === "GET" && path === "/pulls") {
      return reply(200, Object.values(repo.pulls).filter((p) => (p.state ?? "open") === "open").map(pullJson));
    }
    if (init.method === "GET" && (m = /^\/pulls\/(\d+)$/.exec(path))) {
      const p = repo.pulls[Number(m[1])];
      if (!p) return reply(404, { message: "Not Found" });
      return reply(200, pullJson(p));
    }
    if (init.method === "GET" && (m = /^\/branches\/(.+)$/.exec(path))) {
      const contexts = repo.protection?.[decodeURIComponent(m[1]!)];
      return reply(200, { name: m[1], protection: contexts ? { enabled: true, required_status_checks: { contexts, checks: [] } } : { enabled: false } });
    }
    if (init.method === "GET" && (m = /^\/rules\/branches\/(.+)$/.exec(path))) {
      const contexts = repo.rulesets?.[decodeURIComponent(m[1]!)];
      return reply(200, contexts ? [{ type: "required_status_checks", parameters: { required_status_checks: contexts.map((context) => ({ context })) } }] : []);
    }
    if (init.method === "GET" && (m = /^\/commits\/([^/]+)\/status$/.exec(path))) {
      return reply(200, { state: "x", statuses: (repo.statuses ?? []).filter((s) => s.sha === m![1]) });
    }
    if (init.method === "GET" && path === "/actions/runs") {
      return reply(200, { workflow_runs: (repo.workflowRuns ?? []).filter((w) => w.head_sha === u.searchParams.get("head_sha")) });
    }
    if (init.method === "GET" && (m = /^\/collaborators\/([^/]+)\/permission$/.exec(path))) {
      const role = repo.roles[decodeURIComponent(m[1]!)];
      if (role === undefined) return reply(404, { message: "Not Found" });
      const permission = role === "maintain" ? "write" : role === "triage" ? "read" : role;
      return reply(200, { permission, role_name: role });
    }
    if (init.method === "GET" && (m = /^\/issues\/(\d+)\/events$/.exec(path))) {
      const all = (repo.events?.[Number(m[1])] ?? []).map((e) => ({ event: e.event, label: { name: e.label }, actor: { login: e.actor }, created_at: "2026-11-20T00:00:00Z" }));
      const page = Number(u.searchParams.get("page") ?? "1");
      const slice = all.slice((page - 1) * eventsPerPage, page * eventsPerPage);
      const headers: Record<string, string> = {};
      if (page * eventsPerPage < all.length) headers.link = `<${u.origin}/repos/o/r/issues/${m[1]}/events?per_page=100&page=${page + 1}>; rel="next"`;
      return reply(200, slice, headers);
    }
    if (init.method === "GET" && path === "" && repo.defaultBranch !== undefined) return reply(200, { default_branch: repo.defaultBranch.name });
    if (init.method === "GET" && (m = /^\/commits\/([^/]+)$/.exec(path)) && decodeURIComponent(m[1]!) === repo.defaultBranch?.name) {
      return reply(200, { sha: repo.defaultBranch.sha });
    }
    if (init.method === "GET" && (m = /^\/git\/trees\/([0-9a-f]+)$/.exec(path))) {
      const tree = repo.trees?.[m[1]!];
      return tree === undefined ? reply(404, { message: "Not Found" }) : reply(200, { sha: m[1], tree, truncated: false });
    }
    if (init.method === "GET" && (m = /^\/git\/blobs\/([0-9a-z]+)$/.exec(path))) {
      const text = repo.blobs?.[m[1]!];
      return text === undefined ? reply(404, { message: "Not Found" }) : reply(200, { encoding: "base64", content: Buffer.from(text).toString("base64") });
    }
    if (init.method === "GET" && (m = /^\/contents\/(.+)$/.exec(path))) {
      const text = repo.files?.[`${decodeURIComponent(m[1]!)}@${u.searchParams.get("ref")}`];
      return text === undefined ? reply(404, { message: "Not Found" }) : reply(200, text);
    }
    if (init.method === "POST" && path === "/check-runs") {
      const b = body as { name: string; head_sha: string; status: string; conclusion?: string; started_at?: string; output?: { title: string; summary: string } };
      const id = nextCheck++;
      (repo.checks ??= []).unshift({
        id,
        name: b.name,
        head_sha: b.head_sha,
        status: b.status,
        conclusion: b.conclusion ?? null,
        ...(b.started_at ? { started_at: b.started_at } : {}),
        ...(b.output ? { output: b.output } : {}),
      });
      return reply(201, { id });
    }
    if (init.method === "GET" && (m = /^\/commits\/([^/]+)\/check-runs$/.exec(path))) {
      const name = u.searchParams.get("check_name");
      const runs = (repo.checks ?? []).filter((c) => c.head_sha === m![1] && (name === null || c.name === name));
      return reply(200, {
        total_count: runs.length,
        check_runs: runs.map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          conclusion: c.conclusion,
          started_at: c.started_at ?? null,
          completed_at: c.completed_at ?? null,
          app: { slug: c.app ?? "github-actions" },
        })),
      });
    }
    if (init.method === "PATCH" && (m = /^\/check-runs\/(\d+)$/.exec(path))) {
      const id = Number(m[1]);
      if (repo.foreignChecks?.includes(id)) return reply(403, { message: "Invalid app_id" });
      const c = repo.checks?.find((x) => x.id === id);
      if (!c) return reply(404, { message: "Not Found" });
      const b = body as { status: string; conclusion?: string; output?: { title: string; summary: string } };
      c.status = b.status;
      c.conclusion = b.conclusion ?? null;
      if (b.output) c.output = b.output;
      return reply(200, { id });
    }
    if (init.method === "DELETE" && (m = /^\/issues\/(\d+)\/labels\/(.+)$/.exec(path))) {
      const p = repo.pulls[Number(m[1])];
      const label = decodeURIComponent(m[2]!);
      if (!p || !p.labels.includes(label)) return reply(404, { message: "Label does not exist" });
      p.labels = p.labels.filter((l) => l !== label);
      return reply(200, []);
    }
    return reply(500, { message: `fake GitHub has no route for ${init.method} ${path}` });
  };
  return { fetch, calls };
}

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const SHA_C = "c".repeat(40);
