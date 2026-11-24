/**
 * CI subcommands of `review-bot` (C-2, C-4, S-9), run by the action in
 * `action/`:
 *
 *   review-bot gate             decide whether this PR event is reviewed;
 *                               wait for CI, resume or time out (C-9)
 *   review-bot complete-check   always-run: complete ai-review/<name> if unfinished
 *   review-bot remove-label     remove the authorization label (per-push lifetime)
 *   review-bot unpack-snapshot  extract the prepared snapshot artifact safely
 *   review-bot fetch-agent-dir  copy the operator's agent directory from the
 *                               default branch or a pinned commit (F-7)
 *   review-bot unpack-agent-dir extract the agent directory with its packages
 *                               installed by the setup job (F-7, C-4)
 *
 * The GitHub token comes from GH_TOKEN (or GITHUB_TOKEN) and is never
 * printed. Exit codes: 0 done, 1 failed, 2 usage error.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { completeIfUnfinished } from "../ci/check.ts";
import { CI_ON_FAILURE, type CiOnFailure, parseCiRequire, parseCiTimeout } from "../ci/ci-wait.ts";
import { DEFAULT_AUTH_LABEL, type GateInputs, type GateResult, gateEventFrom, layerGateInputs, type WaitingInfo, LIFETIMES, type LabelLifetime, runGate } from "../ci/gate.ts";
import { BOT_VERSION, FINGERPRINT_VERSION, gateRunRecord, PI_PINNED_VERSION, safeSummary, type RunRecord, type WaitingInput } from "../core/index.ts";
// Directly, not through pipeline/index.ts: the gate does not load pi (F-7).
import { type AgentSettings, ConfigError, readAgentSettings } from "../pipeline/agent-settings.ts";
import { Github, type Fetch } from "../ci/github.ts";
import { unpackSnapshot } from "../ci/snapshot.ts";
import { fetchAgentDir } from "../ci/agent-dir.ts";
import { unpackTarGz } from "../ci/tar.ts";
import type { Io } from "./main.ts";

/** The one top-level entry of the setup job's archive (action/run.sh `setup`). */
export const AGENT_ARCHIVE_TOP = "agent";

export const CI_COMMANDS = ["gate", "complete-check", "remove-label", "unpack-snapshot", "fetch-agent-dir", "unpack-agent-dir"] as const;
export type CiCommand = (typeof CI_COMMANDS)[number];

export const CI_USAGE = `CI commands (used by the action; see docs/installing.md):
  review-bot gate [--repo o/r] [--event-name N] [--event-path F] [--pr N]
                  [--name main] [--agent-dir D] [--label ai-review/approved]
                  [--lifetime per-push|per-pr] [--ci-require off|required|NAMES]
                  [--ci-on-failure skip|review] [--ci-timeout 6h] [--ignore-ci]
                  [--output F] [--records-dir D]
  review-bot complete-check --head-sha SHA [--repo o/r] [--name main] [--outcome O]
  review-bot remove-label --pr N [--repo o/r] [--label L]
  review-bot unpack-snapshot --archive F --dest D [--max-gb N]
  review-bot fetch-agent-dir --path P --dest D [--repo o/r] [--ref SHA]
                  The agent directory P of o/r at the default branch's head,
                  or at the pinned commit SHA; never from a PR (F-7, D-19)
  review-bot unpack-agent-dir --archive F --dest D [--max-gb N]
                  The setup job's archive of the agent directory with its
                  packages installed (one top-level agent/), extracted with
                  the snapshot's validating extractor (F-7, C-4)

Defaults come from the Actions environment (GITHUB_REPOSITORY,
GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_OUTPUT, GITHUB_API_URL). The
token is read from GH_TOKEN or GITHUB_TOKEN. The gate handles
pull_request_target and workflow_dispatch for one PR, and workflow_run,
status and schedule to resume or time out PRs waiting for CI (C-9).
Label, lifetime and CI wait: reviewBot.authorization and reviewBot.ci in
the --agent-dir settings.json, then the flags given here, then
.review/review-bot.yaml on the base branch, which is the repository's own
policy for these keys (F-7). Unset everywhere: ai-review/approved,
per-push, no CI wait. The gate reads settings.json as JSON, without pi.
`;

class UsageError extends Error {}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;
const SHA = /^[0-9a-f]{40}$/;

export interface CiDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
}

function github(env: NodeJS.ProcessEnv, repo: string | undefined, fetch: Fetch | undefined): Github {
  const r = repo ?? env.GITHUB_REPOSITORY;
  if (r === undefined || r === "") throw new UsageError("no repository: give --repo or set GITHUB_REPOSITORY");
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN ?? "";
  if (token === "") throw new UsageError("no GitHub token: set GH_TOKEN");
  return new Github({ token, repo: r, ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}), ...(fetch ? { fetch } : {}) });
}

function checkName(name: string | undefined): string {
  const n = name ?? "main";
  if (!NAME.test(n)) throw new UsageError(`invalid --name: ${n}`);
  return n;
}

function prNumber(v: string | undefined, required: boolean): number | undefined {
  if (v === undefined || v === "") {
    if (required) throw new UsageError("--pr is required");
    return undefined;
  }
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new UsageError(`invalid --pr: ${v}`);
  return n;
}

/** `key=value` lines for $GITHUB_OUTPUT. Values are single-line by construction. */
function writeOutputs(file: string | undefined, values: Record<string, string>, io: Io): void {
  const lines = Object.entries(values)
    .map(([k, v]) => `${k}=${v.replace(/[\r\n]+/g, " ")}`)
    .join("\n");
  if (file !== undefined && file !== "") appendFileSync(file, lines + "\n");
  else io.stdout(lines + "\n");
}

/**
 * One run record per check the gate completed itself (R-2 exit: every run
 * completes its check and leaves a record; A-6). The review job writes the
 * record of a run that went on to review.
 */
export function gateRecords(result: GateResult, o: { repo: string; trigger: string; env: NodeJS.ProcessEnv; startedAt: Date; finishedAt: Date }): RunRecord[] {
  const base = o.env.GITHUB_RUN_ID ? `${o.env.GITHUB_RUN_ID}-${o.env.GITHUB_RUN_ATTEMPT ?? "1"}` : `local-${o.startedAt.getTime()}`;
  return result.ended.map((e) =>
    gateRunRecord({
      repo: o.repo,
      prNumber: e.pr.number,
      baseSha: e.pr.baseSha,
      headSha: e.pr.headSha,
      runId: `${base}-gate-pr${e.pr.number}-${e.pr.headSha.slice(0, 7)}`,
      trigger: o.trigger,
      startedAt: o.startedAt,
      finishedAt: o.finishedAt,
      conclusion: e.conclusion,
      summary: `${e.output.title}: ${e.output.summary}`,
      kind: e.kind,
      piVersion: PI_PINNED_VERSION,
      botVersion: BOT_VERSION,
      fingerprintVersion: FINGERPRINT_VERSION,
      ...(e.waiting === undefined ? {} : { waiting: waitingInput(e.waiting) }),
    }),
  );
}

const RESUMED_BY = ["workflow_run", "status", "schedule"] as const;

function waitingInput(w: WaitingInfo): WaitingInput {
  const { resumedBy, ...rest } = w;
  const r = RESUMED_BY.find((x) => x === resumedBy);
  return r === undefined ? rest : { ...rest, resumedBy: r };
}

/** Recording failures never affect the gate's decision (S-8). */
function writeGateRecords(dir: string, records: RunRecord[], log: (line: string) => void): void {
  if (records.length === 0) return;
  try {
    mkdirSync(dir, { recursive: true });
    for (const r of records) writeFileSync(join(dir, `run-${r.run.runId}.json`), JSON.stringify(r, null, 2) + "\n");
    log(`${records.length} gate run record(s) written to ${dir}`);
  } catch (e) {
    log(`gate run records could not be written: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function runCi(command: CiCommand, argv: string[], io: Io, deps: CiDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const log = (line: string) => io.stderr(`[review-bot ${command}] ${line}\n`);
  try {
    switch (command) {
      case "gate": {
        const a = parseArgs({
          args: argv,
          options: {
            repo: { type: "string" },
            "event-name": { type: "string" },
            "event-path": { type: "string" },
            pr: { type: "string" },
            name: { type: "string" },
            "agent-dir": { type: "string" },
            label: { type: "string" },
            lifetime: { type: "string" },
            "ci-require": { type: "string" },
            "ci-on-failure": { type: "string" },
            "ci-timeout": { type: "string" },
            "ignore-ci": { type: "boolean" },
            output: { type: "string" },
            "records-dir": { type: "string" },
          },
          strict: true,
        }).values;
        const startedAt = new Date();
        const eventName = a["event-name"] ?? env.GITHUB_EVENT_NAME;
        const eventPath = a["event-path"] ?? env.GITHUB_EVENT_PATH;
        if (!eventName) throw new UsageError("no event: give --event-name or set GITHUB_EVENT_NAME");
        const payload = eventPath ? (JSON.parse(readFileSync(resolve(eventPath), "utf8")) as unknown) : {};
        // Not given (or empty, as an unset workflow input arrives) is not a default: settings show through (F-7).
        const lifetime = a.lifetime === undefined || a.lifetime === "" ? undefined : (a.lifetime as LabelLifetime);
        if (lifetime !== undefined && !LIFETIMES.includes(lifetime)) throw new UsageError(`--lifetime must be ${LIFETIMES.join(" or ")}`);
        const label = a.label === undefined || a.label.trim() === "" ? undefined : a.label.trim();
        const pr = prNumber(a.pr, false);
        let event;
        try {
          event = gateEventFrom(eventName, payload, pr);
        } catch (e) {
          throw new UsageError(e instanceof Error ? e.message : String(e));
        }
        const ci: GateInputs["ci"] = {};
        try {
          if (a["ci-require"] !== undefined && a["ci-require"].trim() !== "") ci.require = parseCiRequire(a["ci-require"]);
          if (a["ci-timeout"] !== undefined && a["ci-timeout"].trim() !== "") ci.timeoutMs = parseCiTimeout(a["ci-timeout"].trim());
        } catch (e) {
          throw new UsageError(e instanceof Error ? e.message : String(e));
        }
        if (a["ci-on-failure"] !== undefined && a["ci-on-failure"].trim() !== "") {
          const f = a["ci-on-failure"].trim() as CiOnFailure;
          if (!CI_ON_FAILURE.includes(f)) throw new UsageError(`--ci-on-failure must be ${CI_ON_FAILURE.join(" or ")}`);
          ci.onFailure = f;
        }
        if (a["ignore-ci"] === true) {
          if (event.name !== "workflow_dispatch") throw new UsageError("--ignore-ci is for a manual dispatch only");
          event.ignoreCi = true;
        }
        let settings: AgentSettings | undefined;
        if (a["agent-dir"] !== undefined && a["agent-dir"] !== "") {
          try {
            settings = readAgentSettings(resolve(a["agent-dir"]));
          } catch (e) {
            // A broken operator configuration fails the gate loudly; the workflow then completes the check (S-9).
            if (e instanceof ConfigError) throw new Error(`agent directory: ${e.message}`);
            throw e;
          }
        }
        const inputs: GateInputs = { name: checkName(a.name), ci, ...(label === undefined ? {} : { label }), ...(lifetime === undefined ? {} : { lifetime }) };
        const gh = github(env, a.repo, deps.fetch);
        const result = await runGate(gh, event, layerGateInputs(inputs, settings), log);
        const d = result.decision;
        log(`${d.kind}${d.kind === "review" ? ` (${d.via})` : ""}${result.pr ? ` #${result.pr.number}` : ""}: ${d.reason}`);
        const review = d.kind === "review" && result.pr !== undefined;
        writeOutputs(
          a.output ?? env.GITHUB_OUTPUT,
          {
            review: String(review),
            "remove-label": String(d.kind === "skip" && d.removeLabel && result.pr !== undefined),
            decision: d.kind,
            reason: d.reason,
            repo: gh.repo,
            pr: result.pr ? String(result.pr.number) : "",
            "head-sha": result.pr?.headSha ?? "",
            "base-sha": result.pr?.baseSha ?? "",
            name: result.config.name,
            label: result.config.label,
            // A-6 Waiting, one JSON line for the review job (validated again there).
            waiting: review && result.waiting ? JSON.stringify(result.waiting) : "",
          },
          io,
        );
        if (env.GITHUB_STEP_SUMMARY) {
          appendFileSync(env.GITHUB_STEP_SUMMARY, `### review-bot gate: ${d.kind}\n\n${safeSummary(d.reason)}\n`);
        }
        const recordsDir = a["records-dir"] ?? env.RB_RECORDS_DIR;
        if (recordsDir !== undefined && recordsDir !== "") {
          writeGateRecords(resolve(recordsDir), gateRecords(result, { repo: gh.repo, trigger: eventName, env, startedAt, finishedAt: new Date() }), log);
        }
        return 0;
      }
      case "complete-check": {
        const a = parseArgs({
          args: argv,
          options: { repo: { type: "string" }, name: { type: "string" }, "head-sha": { type: "string" }, outcome: { type: "string" } },
          strict: true,
        }).values;
        const sha = a["head-sha"] ?? "";
        if (!SHA.test(sha)) throw new UsageError(`--head-sha must be a 40-character SHA`);
        const gh = github(env, a.repo, deps.fetch);
        await completeIfUnfinished(gh, checkName(a.name), sha, a.outcome ?? "", log);
        return 0;
      }
      case "remove-label": {
        const a = parseArgs({ args: argv, options: { repo: { type: "string" }, pr: { type: "string" }, label: { type: "string" } }, strict: true }).values;
        const pr = prNumber(a.pr, true)!;
        const label = a.label === undefined || a.label.trim() === "" ? DEFAULT_AUTH_LABEL : a.label.trim();
        const gh = github(env, a.repo, deps.fetch);
        const removed = await gh.removeLabel(pr, label);
        log(removed ? `removed "${label}" from #${pr}` : `"${label}" was not on #${pr}`);
        return 0;
      }
      case "fetch-agent-dir": {
        const a = parseArgs({ args: argv, options: { repo: { type: "string" }, path: { type: "string" }, ref: { type: "string" }, dest: { type: "string" } }, strict: true }).values;
        if (a.path === undefined || a.dest === undefined) throw new UsageError("--path and --dest are required");
        const ref = a.ref === undefined || a.ref === "" ? undefined : a.ref;
        if (ref !== undefined && !SHA.test(ref)) throw new UsageError("--ref must be a 40-character commit SHA");
        const gh = github(env, a.repo, deps.fetch);
        const got = await fetchAgentDir(gh, { path: a.path, dest: resolve(a.dest), ...(ref === undefined ? {} : { ref }) });
        log(`agent directory ${a.path} from ${got.repo}@${got.sha}${got.branch === undefined ? " (pinned)" : ` (default branch ${got.branch})`}: ${got.files} files, ${got.bytes} bytes`);
        return 0;
      }
      case "unpack-agent-dir": {
        const a = parseArgs({ args: argv, options: { archive: { type: "string" }, dest: { type: "string" }, "max-gb": { type: "string" } }, strict: true }).values;
        if (a.archive === undefined || a.dest === undefined) throw new UsageError("--archive and --dest are required");
        const gb = a["max-gb"] === undefined ? 4 : Number(a["max-gb"]);
        if (!(gb > 0)) throw new UsageError(`invalid --max-gb: ${a["max-gb"]}`);
        const dest = resolve(a.dest);
        // Same rules as the snapshot: no hard links or devices, no `..`, nothing
        // written through a symlink, files read-only and never executable.
        const stats = await unpackTarGz(resolve(a.archive), dest, { allowedTop: [AGENT_ARCHIVE_TOP], maxBytes: gb * 1024 ** 3 });
        if (!existsSync(join(dest, AGENT_ARCHIVE_TOP))) throw new Error(`the agent directory archive has no ${AGENT_ARCHIVE_TOP}/ directory`);
        log(`agent directory with installed packages: ${stats.files} files, ${stats.symlinks} symlinks, ${(stats.bytes / 1024 ** 2).toFixed(1)} MiB`);
        return 0;
      }
      case "unpack-snapshot": {
        const a = parseArgs({ args: argv, options: { archive: { type: "string" }, dest: { type: "string" }, "max-gb": { type: "string" } }, strict: true }).values;
        if (a.archive === undefined || a.dest === undefined) throw new UsageError("--archive and --dest are required");
        const gb = a["max-gb"] === undefined ? 16 : Number(a["max-gb"]);
        if (!(gb > 0)) throw new UsageError(`invalid --max-gb: ${a["max-gb"]}`);
        const { manifest, stats } = await unpackSnapshot(resolve(a.archive), resolve(a.dest), { maxBytes: gb * 1024 ** 3 });
        log(
          `${manifest.repo}#${manifest.pr} base ${manifest.baseSha.slice(0, 7)} head ${manifest.headSha.slice(0, 7)}: ${stats.files} files, ${stats.symlinks} symlinks, ${(stats.bytes / 1024 ** 2).toFixed(1)} MiB; module cache ${manifest.modcache.status}${manifest.modcache.detail ? ` (${manifest.modcache.detail})` : ""}`,
        );
        return 0;
      }
    }
  } catch (e) {
    if (e instanceof UsageError || (e instanceof TypeError && "code" in e && String((e as { code?: string }).code).startsWith("ERR_PARSE_ARGS"))) {
      io.stderr(`${e.message}\n\n${CI_USAGE}`);
      return 2;
    }
    log(`failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
