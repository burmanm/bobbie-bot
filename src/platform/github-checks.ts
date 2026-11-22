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
 *
 * The run that posted a review also records its id in `external_id`
 * (D-5, H-50; github-markers.ts). An update without that field keeps it.
 */
import { GitHubApiError, type GitHubClient } from "./github-client.ts";
import type { RecordingRun } from "./github-markers.ts";
import type { CheckRunCompletion } from "./types.ts";

export const CHECK_NAME_RE = /^ai-review\/[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
/** GitHub's limit on `output.summary`. */
const SUMMARY_MAX = 65_535;
const TITLE_MAX = 255;
/** GitHub keeps at most 1000 runs of one name in a check suite. */
const MAX_PAGES = 10;

export interface CheckRunRef {
  id: number;
  status: string;
  conclusion: string | null;
  /** Slug of the App that created it. */
  app?: string;
}

interface CheckRunJson extends RecordingRun {
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
  if (run === undefined) return undefined;
  const ref: CheckRunRef = { id: run.id, status: run.status, conclusion: run.conclusion };
  if (run.app?.slug !== undefined) ref.app = run.app.slug;
  return ref;
}

/**
 * Every check run with this name on a commit, to look up review records.
 * None for a commit the repository does not have (any more).
 */
export async function listCheckRuns(client: GitHubClient, repo: string, name: string, sha: string): Promise<RecordingRun[]> {
  validate(repo, name, sha);
  const out: RecordingRun[] = [];
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await client.get<{ check_runs?: CheckRunJson[] }>(
        `repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&filter=all&per_page=100&page=${page}`,
      );
      const runs = res.check_runs ?? [];
      out.push(...runs.filter((r) => r.name === name));
      if (runs.length < 100) break;
    }
  } catch (e) {
    // Anything else is thrown: guessing "no record" would post the review twice (C-1).
    if (e instanceof GitHubApiError && (e.status === 404 || e.status === 422)) return [];
    throw e;
  }
  return out;
}

/** Write the record of a posted review on this run's check. */
export async function recordOnCheckRun(client: GitHubClient, repo: string, id: number, externalId: string): Promise<void> {
  await client.request("PATCH", `repos/${repo}/check-runs/${id}`, { body: { external_id: externalId } });
}

export interface OpenCheckOptions {
  detailsUrl?: string;
  now?: () => Date;
}

/**
 * S-1: the check in progress on the head SHA. An open run of the same name
 * (queued by the workflow, or left by a crashed attempt of this SHA) is
 * reused; otherwise a new one is created. Returns its id and the App it
 * belongs to, which is the identity this run acts as.
 */
export async function openCheckRun(client: GitHubClient, repo: string, name: string, headSha: string, o: OpenCheckOptions = {}): Promise<{ id: number; app?: string }> {
  validate(repo, name, headSha);
  const now = (o.now ?? (() => new Date()))().toISOString();
  const existing = await findCheckRun(client, repo, name, headSha);
  const body: Record<string, unknown> = { status: "in_progress", started_at: now };
  if (o.detailsUrl !== undefined) body.details_url = o.detailsUrl;
  if (existing !== undefined && existing.status !== "completed") {
    await client.request("PATCH", `repos/${repo}/check-runs/${existing.id}`, { body });
    // Only its creator can update a check run, so its App is ours.
    return { id: existing.id, ...(existing.app === undefined ? {} : { app: existing.app }) };
  }
  const created = await client.request<CheckRunJson>("POST", `repos/${repo}/check-runs`, {
    body: { name, head_sha: headSha, ...body },
    probe: async () => {
      const r = await findCheckRun(client, repo, name, headSha);
      return r !== undefined && r.status !== "completed" && r.id !== existing?.id
        ? ({ id: r.id, name, status: r.status, conclusion: r.conclusion, ...(r.app === undefined ? {} : { app: { slug: r.app } }) } as CheckRunJson)
        : undefined;
    },
  });
  const app = created.data.app?.slug;
  return { id: created.data.id, ...(app === undefined ? {} : { app }) };
}

export interface CompleteCheckOptions {
  /** The run to complete, when known (the review job opened it). */
  id?: number;
  /**
   * Without an id: leave an already completed run alone (default true). The
   * always-run step must not overwrite the conclusion the pipeline set.
   */
  onlyIfIncomplete?: boolean;
  /** The record of the review this run posted. Left out, the run keeps what it has. */
  externalId?: string;
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
  if (o.externalId !== undefined) body.external_id = o.externalId;

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
