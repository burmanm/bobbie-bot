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
  }>;
  /** login → role_name; anything missing is a 404. */
  roles: Record<string, string>;
  /** PR number → label events, oldest first. */
  events?: Record<number, Array<{ event: string; label: string; actor: string }>>;
  /** "path@ref" → text */
  files?: Record<string, string>;
  checks?: Array<{ id: number; name: string; head_sha: string; status: string; conclusion: string | null; app?: string }>;
  /** Check run ids whose update is refused (created by another identity). */
  foreignChecks?: number[];
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
    if (init.method === "GET" && (m = /^\/pulls\/(\d+)$/.exec(path))) {
      const p = repo.pulls[Number(m[1])];
      if (!p) return reply(404, { message: "Not Found" });
      return reply(200, {
        number: p.number,
        state: p.state ?? "open",
        draft: p.draft ?? false,
        user: { login: p.user.login, type: p.user.type ?? "User" },
        labels: p.labels.map((name) => ({ name })),
        head: { sha: p.head },
        base: { sha: p.base },
      });
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
    if (init.method === "GET" && (m = /^\/contents\/(.+)$/.exec(path))) {
      const text = repo.files?.[`${decodeURIComponent(m[1]!)}@${u.searchParams.get("ref")}`];
      return text === undefined ? reply(404, { message: "Not Found" }) : reply(200, text);
    }
    if (init.method === "POST" && path === "/check-runs") {
      const b = body as { name: string; head_sha: string; status: string; conclusion: string };
      const id = nextCheck++;
      (repo.checks ??= []).unshift({ id, name: b.name, head_sha: b.head_sha, status: b.status, conclusion: b.conclusion });
      return reply(201, { id });
    }
    if (init.method === "GET" && (m = /^\/commits\/([^/]+)\/check-runs$/.exec(path))) {
      const name = u.searchParams.get("check_name");
      const runs = (repo.checks ?? []).filter((c) => c.head_sha === m![1] && c.name === name);
      return reply(200, { total_count: runs.length, check_runs: runs.map((c) => ({ id: c.id, status: c.status, conclusion: c.conclusion, app: { slug: c.app ?? "github-actions" } })) });
    }
    if (init.method === "PATCH" && (m = /^\/check-runs\/(\d+)$/.exec(path))) {
      const id = Number(m[1]);
      if (repo.foreignChecks?.includes(id)) return reply(403, { message: "Invalid app_id" });
      const c = repo.checks?.find((x) => x.id === id);
      if (!c) return reply(404, { message: "Not Found" });
      const b = body as { status: string; conclusion: string };
      c.status = b.status;
      c.conclusion = b.conclusion;
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
