/**
 * Check run `ai-review/<name>` (I-2 #1, S-1, S-9).
 *
 * The review run opens it in progress at intake and completes it on every
 * exit path. `completeCheckRun` also stands alone, without the pipeline, for
 * the workflow's always-run step (crash, cancellation, timeout) and for the
 * gate job (not authorized → skipped): it completes the latest run of that
 * name on the head SHA if it is still open, or creates a completed one if
 * there is none.
 *
 * A check run can be updated only by the identity that created it (the
 * Actions app or the review App, C-5), so the gate job, the review job and
 * the always-run step must use the same identity.
 */
import type { GitHubClient } from "./github-client.ts";
import type { CheckRunCompletion } from "./types.ts";

export const CHECK_NAME_RE = /^ai-review\/[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
/** GitHub's limit on `output.summary`. */
const SUMMARY_MAX = 65_535;
const TITLE_MAX = 255;

export interface CheckRunRef {
  id: number;
  status: string;
  conclusion: string | null;
}

interface CheckRunJson {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

function validate(repo: string, name: string, headSha: string): void {
  if (!REPO_RE.test(repo)) throw new Error(`invalid repository: ${repo}`);
  if (!CHECK_NAME_RE.test(name)) throw new Error(`invalid check name: ${name} (expected ai-review/<name>)`);
  if (!SHA_RE.test(headSha)) throw new Error(`invalid head SHA for check ${name}: ${JSON.stringify(headSha)}`);
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** The latest check run with this name on the head SHA, if any. */
export async function findCheckRun(client: GitHubClient, repo: string, name: string, headSha: string): Promise<CheckRunRef | undefined> {
  validate(repo, name, headSha);
  const res = await client.get<{ check_runs?: CheckRunJson[] }>(
    `repos/${repo}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest&per_page=100`,
  );
  // Newest first; filter=latest already keeps one per app.
  const run = (res.check_runs ?? []).filter((r) => r.name === name).sort((a, b) => b.id - a.id)[0];
  return run === undefined ? undefined : { id: run.id, status: run.status, conclusion: run.conclusion };
}

export interface OpenCheckOptions {
  detailsUrl?: string;
  now?: () => Date;
}

/**
 * S-1: the check in progress on the head SHA. An open run of the same name
 * (queued by the workflow, or left by a crashed attempt of this SHA) is
 * reused; otherwise a new one is created. Returns its id.
 */
export async function openCheckRun(client: GitHubClient, repo: string, name: string, headSha: string, o: OpenCheckOptions = {}): Promise<number> {
  validate(repo, name, headSha);
  const now = (o.now ?? (() => new Date()))().toISOString();
  const existing = await findCheckRun(client, repo, name, headSha);
  const body: Record<string, unknown> = { status: "in_progress", started_at: now };
  if (o.detailsUrl !== undefined) body.details_url = o.detailsUrl;
  if (existing !== undefined && existing.status !== "completed") {
    await client.request("PATCH", `repos/${repo}/check-runs/${existing.id}`, { body });
    return existing.id;
  }
  const created = await client.request<CheckRunJson>("POST", `repos/${repo}/check-runs`, {
    body: { name, head_sha: headSha, ...body },
    probe: async () => {
      const r = await findCheckRun(client, repo, name, headSha);
      return r !== undefined && r.status !== "completed" && r.id !== existing?.id ? ({ id: r.id, name, status: r.status, conclusion: r.conclusion } as CheckRunJson) : undefined;
    },
  });
  return created.data.id;
}

export interface CompleteCheckOptions {
  /** The run to complete, when known (the review job opened it). */
  id?: number;
  /**
   * Without an id: leave an already completed run alone (default true). The
   * always-run step must not overwrite the conclusion the pipeline set.
   */
  onlyIfIncomplete?: boolean;
  detailsUrl?: string;
  now?: () => Date;
}

export type CompleteCheckAction = "updated" | "created" | "already-completed";

/**
 * Complete `ai-review/<name>` on the head SHA (S-7, S-9): success, skipped
 * or neutral, with a one-line title and a summary.
 */
export async function completeCheckRun(
  client: GitHubClient,
  repo: string,
  c: CheckRunCompletion,
  o: CompleteCheckOptions = {},
): Promise<{ action: CompleteCheckAction; id: number }> {
  validate(repo, c.name, c.headSha);
  if (!["success", "skipped", "neutral"].includes(c.conclusion)) throw new Error(`invalid check conclusion: ${c.conclusion}`);
  const now = (o.now ?? (() => new Date()))().toISOString();
  const body: Record<string, unknown> = {
    status: "completed",
    conclusion: c.conclusion,
    completed_at: now,
    output: { title: clip(c.title.replace(/\s+/g, " ").trim() || c.conclusion, TITLE_MAX), summary: clip(c.summary || c.title, SUMMARY_MAX) },
  };
  if (o.detailsUrl !== undefined) body.details_url = o.detailsUrl;

  let id = o.id;
  if (id === undefined) {
    const existing = await findCheckRun(client, repo, c.name, c.headSha);
    if (existing !== undefined && existing.status === "completed" && (o.onlyIfIncomplete ?? true)) {
      return { action: "already-completed", id: existing.id };
    }
    id = existing?.id;
  }
  if (id !== undefined) {
    await client.request("PATCH", `repos/${repo}/check-runs/${id}`, { body });
    return { action: "updated", id };
  }
  const created = await client.request<CheckRunJson>("POST", `repos/${repo}/check-runs`, {
    body: { name: c.name, head_sha: c.headSha, started_at: now, ...body },
    probe: async () => {
      const r = await findCheckRun(client, repo, c.name, c.headSha);
      return r !== undefined && r.status === "completed" ? ({ id: r.id, name: c.name, status: r.status, conclusion: r.conclusion } as CheckRunJson) : undefined;
    },
  });
  return { action: "created", id: created.data.id };
}
