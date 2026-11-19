/**
 * CI subcommands of `review-bot` (C-2, C-4, S-9), run by the action in
 * `action/`:
 *
 *   review-bot gate             decide whether this PR event is reviewed
 *   review-bot complete-check   always-run: complete ai-review/<name> if unfinished
 *   review-bot remove-label     remove the authorization label (per-push lifetime)
 *   review-bot unpack-snapshot  extract the prepared snapshot artifact safely
 *
 * The GitHub token comes from GH_TOKEN (or GITHUB_TOKEN) and is never
 * printed. Exit codes: 0 done, 1 failed, 2 usage error.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { completeIfUnfinished } from "../ci/check.ts";
import { DEFAULT_AUTH_LABEL, gateEventFrom, LIFETIMES, type LabelLifetime, runGate } from "../ci/gate.ts";
import { Github, type Fetch } from "../ci/github.ts";
import { unpackSnapshot } from "../ci/snapshot.ts";
import type { Io } from "./main.ts";

export const CI_COMMANDS = ["gate", "complete-check", "remove-label", "unpack-snapshot"] as const;
export type CiCommand = (typeof CI_COMMANDS)[number];

export const CI_USAGE = `CI commands (used by the action; see docs/installing.md):
  review-bot gate [--repo o/r] [--event-name N] [--event-path F] [--pr N]
                  [--name main] [--label ai-review/approved] [--lifetime per-push|per-pr]
                  [--output F]
  review-bot complete-check --head-sha SHA [--repo o/r] [--name main] [--outcome O]
  review-bot remove-label --pr N [--repo o/r] [--label L]
  review-bot unpack-snapshot --archive F --dest D [--max-gb N]

Defaults come from the Actions environment (GITHUB_REPOSITORY,
GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_OUTPUT, GITHUB_API_URL). The
token is read from GH_TOKEN or GITHUB_TOKEN.
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
            label: { type: "string" },
            lifetime: { type: "string" },
            output: { type: "string" },
          },
          strict: true,
        }).values;
        const eventName = a["event-name"] ?? env.GITHUB_EVENT_NAME;
        const eventPath = a["event-path"] ?? env.GITHUB_EVENT_PATH;
        if (!eventName) throw new UsageError("no event: give --event-name or set GITHUB_EVENT_NAME");
        const payload = eventPath ? (JSON.parse(readFileSync(resolve(eventPath), "utf8")) as unknown) : {};
        const lifetime = (a.lifetime === undefined || a.lifetime === "" ? "per-push" : a.lifetime) as LabelLifetime;
        if (!LIFETIMES.includes(lifetime)) throw new UsageError(`--lifetime must be ${LIFETIMES.join(" or ")}`);
        const label = a.label === undefined || a.label.trim() === "" ? DEFAULT_AUTH_LABEL : a.label.trim();
        const pr = prNumber(a.pr, false);
        let event;
        try {
          event = gateEventFrom(eventName, payload, pr);
        } catch (e) {
          throw new UsageError(e instanceof Error ? e.message : String(e));
        }
        const gh = github(env, a.repo, deps.fetch);
        const result = await runGate(gh, event, { name: checkName(a.name), label, lifetime }, log);
        const d = result.decision;
        log(`${d.kind}${d.kind === "review" ? ` (${d.via})` : ""}: ${d.reason}`);
        writeOutputs(
          a.output ?? env.GITHUB_OUTPUT,
          {
            review: String(d.kind === "review"),
            "remove-label": String(d.kind === "skip" && d.removeLabel),
            decision: d.kind,
            reason: d.reason,
            repo: gh.repo,
            pr: String(result.pr.number),
            "head-sha": result.pr.headSha,
            "base-sha": result.pr.baseSha,
            name: result.config.name,
            label: result.config.label,
          },
          io,
        );
        if (env.GITHUB_STEP_SUMMARY) {
          appendFileSync(env.GITHUB_STEP_SUMMARY, `### review-bot gate: ${d.kind}\n\n${d.reason}\n`);
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
