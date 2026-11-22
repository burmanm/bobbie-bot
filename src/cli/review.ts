/**
 * The review: argument handling and the run, shared by `review-bot review`
 * (src/cli/main.ts) and the pi command `/review-bot`
 * (pi-review/command/index.ts), so both take the same options and produce
 * the same result (F-3, R-1a step 3).
 *
 * Exit codes: 0 reviewed or skipped, 1 could not complete (neutral check)
 * or a configuration error, 2 usage error.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PreparedSnapshots, preparedModcache } from "../ci/snapshot.ts";
// Types only from agent/ and pipeline/index.ts: both load pi, which the CI
// commands never need (F-7). The review imports them when it runs.
import type { AcpAgentConfig, AgentStep, Script, ThinkingLevel } from "../agent/index.ts";
import { THINKING_LEVELS } from "../agent/types.ts";
import {
  defaultModcache,
  DryRunPlatform,
  type FetchLike,
  FixturePrReader,
  GhPrReader,
  gitHubClientFromEnv,
  GitHubPlatform,
  GhTarballSnapshots,
  GitArchiveSnapshots,
  parsePrRef,
  type PrReader,
  type SnapshotSource,
} from "../platform/index.ts";
import type { ConfigInputs } from "../pipeline/config.ts";
import { type AgentSettings, ConfigError, parseDuration, PIPELINE_ROLES, type PipelineRole, readAgentSettings } from "../pipeline/agent-settings.ts";
import { GhHistory } from "../platform/history-github.ts";
import { Value } from "typebox/value";
import { WaitingInput } from "../core/index.ts";
import { AtHeadReader } from "../platform/history-head.ts";

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** The review's options, for every entry point (node:util parseArgs). */
export const REVIEW_OPTIONS = {
    "dry-run": { type: "boolean" },
  live: { type: "boolean" },
    pr: { type: "string" },
    "repo-dir": { type: "string" },
    "snapshot-dir": { type: "string" },
    fixture: { type: "string" },
    head: { type: "string" },
    "as-of": { type: "string" },
    "no-history": { type: "boolean" },
    "knowledge-dir": { type: "string" },
    "agent-dir": { type: "string" },
    guidelines: { type: "string", multiple: true },
    model: { type: "string", multiple: true },
    thinking: { type: "string", multiple: true },
    providers: { type: "string", multiple: true },
    "acp-agent": { type: "string", multiple: true },
    "acp-config": { type: "string" },
    script: { type: "string" },
    name: { type: "string" },
    modcache: { type: "string" },
    "no-modcache": { type: "boolean" },
    "runs-dir": { type: "string" },
    "max-cost": { type: "string" },
    "run-timeout": { type: "string" },
    "max-run-timeout": { type: "string" },
    waiting: { type: "string" },
    "step-timeout": { type: "string", multiple: true },
    "idle-timeout": { type: "string", multiple: true },
    "include-drafts": { type: "boolean" },
    out: { type: "string" },
    quiet: { type: "boolean" },
    help: { type: "boolean", short: "h" },
} as const;

/**
 * Options whose value is a path. A launcher that starts pi in another
 * working directory makes them absolute first (C-3a: the parent pi's
 * working directory is an empty one).
 */
export const REVIEW_PATH_OPTIONS = [
  "repo-dir",
  "snapshot-dir",
  "fixture",
  "knowledge-dir",
  "agent-dir",
  "guidelines",
  "acp-config",
  "script",
  "modcache",
  "runs-dir",
  "out",
] as const satisfies readonly (keyof typeof REVIEW_OPTIONS)[];

export const REVIEW_OPTIONS_USAGE = `Source:
  --pr <ref>               The PR on GitHub (dry run: read-only through gh)
  --repo-dir <dir>         Extract trees with git archive from this clone
                           (default with --pr: download tarballs through gh)
  --snapshot-dir <dir>     Use trees prepared by the CI prepare job
                           (manifest.json, base/, head/, modcache/), C-4
  --fixture <dir>          Read the PR from a fixture directory
  --head <sha>             With --pr: review the PR as it was at this earlier
                           head (replays, E-2). Base = merge base; comments
                           made after the head's commit time are left out
  --as-of <time>           With --head: cutoff for comments and history
                           (ISO 8601) instead of the head's commit time
  --no-history             Do not offer git_log/git_blame/git_show/
                           search_issues (default with --pr: offered via gh)

Knowledge (default: AGENTS.md, REVIEW.md, .review/*-guidelines.md from the base tree):
  --knowledge-dir <dir>    Read AGENTS.md, REVIEW.md, .review/ from here instead
  --guidelines <file>      Add a guidelines file (repeatable)

Configuration (F-7): the agent directory's settings.json, then the flags
below, then .review/review-bot.yaml on the base branch, which can only
narrow: lower limits, and pick a model among enabledModels. It cannot raise
a limit or name another model.
  --agent-dir <dir>        The operator's pi agent directory: settings.json
                           (reviewBot, enabledModels) and models.json
                           (providers, endpoints, model overrides). Without
                           it: no settings and no enabledModels, so the
                           models are the --model flags and the YAML cannot
                           change them

Models (no defaults):
  --model <role>=<provider>/<id>[:<thinking>]
                                   role is reviewer or verifier (repeatable);
                                   replaces the role's model in settings.json.
                                   A pi provider runs in pi; "acp/<agent>"
                                   runs an ACP agent (below)
  --thinking <role>=<level>        off, minimal, low, medium, high, xhigh, max
                                   (as pi's --thinking: over a :suffix)
  --providers <role>=<a,b,...>     OpenRouter only: serve the role's model only
                                   from these providers (routing "only", no
                                   fallbacks), e.g. reviewer=anthropic,amazon-bedrock
  --script <file>          Use a scripted model (JSON) instead of a provider

ACP agents (Agent Client Protocol, started as a subprocess over stdio):
  --acp-agent <name>=<command> [args]   Define agent <name>; use it with
                                   --model <role>=acp/<name> (repeatable)
  --acp-config <file>      JSON: {"agents": {"<name>": {"command": "...",
                           "args": [...], "env": {...}, "model": "..."}}}

Run:
  --name <name>            Reviewer name; check run ai-review/<name> (default main)
  --modcache <dir>         Dependency source cache (default: Go module cache if present)
  --no-modcache            Do not offer a dependency source cache
  --runs-dir <dir>         Parent of the run directory (default: <tmp>/review-bot-runs)
  --max-cost <usd>         Run spend cap
  --run-timeout <duration> Whole-run deadline (default 45m): the running step
                           is stopped and what exists is published as partial
  --max-run-timeout <duration>  Ceiling on the run deadline, whatever settings,
                           flags or the YAML say (the CI job's own limit);
                           a lower configured value still takes effect
  --step-timeout [<role>=]<duration>  Per-step wall-clock limit (default
                           reviewer 20m, verifier 8m); no role = both roles
  --idle-timeout [<role>=]<duration>  Stop a step after this long with no
                           model output or tool activity (default 3m)
                           Durations: 90s, 20m, 1.5h; a bare number is seconds.
                           .review/review-bot.yaml on the base branch can
                           only lower these
  --waiting <json>         What the CI gate knew about the wait (C-9), as its
                           "waiting" output: recorded in the run record
                           (A-6) and a failed CI reviewed anyway is said in
                           the summary
  --include-drafts         Review draft PRs too
  --live                   Post to GitHub: the default except for the
                           interactive /review-bot, which dry-runs
  --out <file>             Also write the would-be review JSON here
  --quiet                  No progress log on stderr

`;

export class UsageError extends Error {}

/** `--waiting`: the gate's JSON line, checked against the record schema (A-6). */
export function parseWaiting(text: string): WaitingInput {
  if (text.length > 16_384) throw new UsageError("--waiting is too long");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UsageError("--waiting is not JSON");
  }
  if (!Value.Check(WaitingInput, data)) {
    const first = [...Value.Errors(WaitingInput, data)][0];
    throw new UsageError(`--waiting is invalid: ${first ? `${first.instancePath || "/"}: ${first.message}` : "schema mismatch"}`);
  }
  return data;
}

function pairs(values: string[] | undefined, what: string): Map<PipelineRole, string> {
  const out = new Map<PipelineRole, string>();
  for (const v of values ?? []) {
    const eq = v.indexOf("=");
    const role = v.slice(0, eq) as PipelineRole;
    if (eq <= 0 || !PIPELINE_ROLES.includes(role)) throw new UsageError(`${what} must be <role>=<value> with role ${PIPELINE_ROLES.join(" or ")}: ${v}`);
    out.set(role, v.slice(eq + 1));
  }
  return out;
}

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** ACP agents from --acp-config, then --acp-agent (which wins for the same name). Operator input only. */
function readAcpAgents(configFile: string | undefined, defs: string[] | undefined): Record<string, AcpAgentConfig> {
  const agents: Record<string, AcpAgentConfig> = {};
  if (configFile !== undefined) {
    let data: { agents?: Record<string, Partial<AcpAgentConfig>> };
    try {
      data = JSON.parse(readFileSync(resolve(configFile), "utf8"));
    } catch (e) {
      throw new UsageError(`cannot read --acp-config ${configFile}: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const [name, a] of Object.entries(data.agents ?? {})) {
      const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
      const env = a.env as unknown;
      if (
        !AGENT_NAME.test(name) ||
        typeof a.command !== "string" ||
        a.command === "" ||
        (a.args !== undefined && !strings(a.args)) ||
        (env !== undefined && (typeof env !== "object" || env === null || !Object.values(env).every((v) => typeof v === "string"))) ||
        (a.model !== undefined && typeof a.model !== "string")
      ) {
        throw new UsageError(`--acp-config: agent "${name}" needs a name of letters, digits, ".", "_", "-", a "command" string, and optional "args" (strings), "env" (string values), "model" (string)`);
      }
      agents[name] = { command: a.command, ...(a.args ? { args: a.args } : {}), ...(a.env ? { env: a.env } : {}), ...(a.model ? { model: a.model } : {}) };
    }
  }
  for (const def of defs ?? []) {
    const eq = def.indexOf("=");
    const name = def.slice(0, eq);
    const words = def.slice(eq + 1).trim().split(/\s+/).filter((w) => w !== "");
    if (eq <= 0 || !AGENT_NAME.test(name) || words.length === 0) throw new UsageError(`--acp-agent must be <name>=<command> [args]: ${def}`);
    agents[name] = { command: words[0]!, args: words.slice(1) };
  }
  return agents;
}

/** --run-timeout, --max-run-timeout, --step-timeout and --idle-timeout into the config inputs (S-4 Limits). */
function applyTimeoutFlags(inputs: ConfigInputs, run: string | undefined, ceiling: string | undefined, step: string[] | undefined, idle: string[] | undefined): void {
  const duration = (flag: string, text: string): number => {
    const ms = parseDuration(text);
    if (ms === undefined) throw new UsageError(`invalid ${flag}: ${text} (use for example 90s, 20m or 1.5h)`);
    return ms;
  };
  if (run !== undefined) inputs.runTimeoutMs = duration("--run-timeout", run);
  if (ceiling !== undefined) inputs.runTimeoutCeilingMs = duration("--max-run-timeout", ceiling);
  const perRole = (flag: string, values: string[] | undefined, key: "timeoutMs" | "idleTimeoutMs") => {
    for (const v of values ?? []) {
      const eq = v.indexOf("=");
      const roles = eq < 0 ? [...PIPELINE_ROLES] : [v.slice(0, eq) as PipelineRole];
      if (eq >= 0 && !PIPELINE_ROLES.includes(roles[0]!)) throw new UsageError(`${flag} role must be ${PIPELINE_ROLES.join(" or ")}: ${v}`);
      const ms = duration(flag, eq < 0 ? v : v.slice(eq + 1));
      inputs.limits ??= {};
      for (const role of roles) inputs.limits[role] = { ...inputs.limits[role], [key]: ms };
    }
  };
  perRole("--step-timeout", step, "timeoutMs");
  perRole("--idle-timeout", idle, "idleTimeoutMs");
}

/** Live-run dependencies, injectable for tests. */
export interface LiveDeps {
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
}

/** How an entry point runs the review. */
export interface ReviewEntry extends LiveDeps {
  /** Usage text shown with a usage error or --help. */
  usage: string;
  /** Run-record trigger: `cli` or `pi-command`, with `-dry-run` / `-dry-run-replay` appended (A-6). */
  trigger: string;
  /** Without --dry-run or --live: dry run (the interactive command) or live. */
  defaultDryRun: boolean;
  /** Also print the result JSON with `io.stdout`. Always written to --out when given. */
  printResult: boolean;
  /** The agent directory when --agent-dir is not given (the command: pi's own, F-7). */
  defaultAgentDir?: string;
  /** Stops the run; what exists is still published as partial (S-9). */
  signal?: AbortSignal;
}

type ReviewArgs = ReturnType<typeof parseReviewArgs>;

/** Parse the review's options; throws a UsageError. */
export function parseReviewArgs(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: REVIEW_OPTIONS, strict: true, allowPositionals: false }).values;
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
}

function runsDir(args: ReviewArgs): string {
  return resolve(args["runs-dir"] ?? join(tmpdir(), "review-bot-runs"));
}

/** Directories known before the run that a configured package must stay out of (C-3a, F-7). */
function knownRoots(args: ReviewArgs): string[] {
  const dirs = [args.fixture, args["repo-dir"], args["snapshot-dir"], args["knowledge-dir"], args.modcache].filter((d): d is string => d !== undefined);
  return [...dirs.map((d) => resolve(d)), runsDir(args)];
}

/** Run one review from its options. */
export async function runReviewCommand(argv: readonly string[], io: Io, entry: ReviewEntry): Promise<number> {
  const usage = entry.usage;
  const deps = entry;
  let args: ReviewArgs;
  try {
    args = parseReviewArgs(argv);
  } catch (e) {
    io.stderr(`${e instanceof Error ? e.message : String(e)}\n\n${usage}`);
    return 2;
  }
  if (args.help) {
    io.stdout(usage);
    return 0;
  }

  try {
    if (args["dry-run"] && args.live) throw new UsageError("give at most one of --dry-run and --live");
    const live = args.live === true || (args["dry-run"] !== true && !entry.defaultDryRun);
    if (live && args.fixture !== undefined) throw new UsageError("--fixture needs --dry-run: a fixture is never posted to GitHub");
    if ((args.pr === undefined) === (args.fixture === undefined)) throw new UsageError("give exactly one of --pr and --fixture");
    if (args.name !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(args.name)) throw new UsageError(`invalid --name: ${args.name}`);

    // PR source and snapshots.
    let reader: PrReader;
    let snapshots: SnapshotSource;
    let prRef: { repo: string; number: number } | undefined;
    let history: GhHistory | undefined;
    let replay: AtHeadReader | undefined;
    if (args.fixture !== undefined && (args.head !== undefined || args["as-of"] !== undefined)) {
      throw new UsageError("--head and --as-of need --pr");
    }
    if (args["as-of"] !== undefined && args.head === undefined) throw new UsageError("--as-of needs --head");
    // A replay reviews an old head; posting it would put a review on a commit
    // the PR no longer points at (S-7, E-4). Replays are dry-run only.
    if (live && args.head !== undefined) throw new UsageError("--head needs --dry-run: a replay is never posted to GitHub");
    if (args.fixture !== undefined) {
      const fixture = new FixturePrReader(resolve(args.fixture));
      reader = fixture;
      snapshots = fixture.snapshots();
    } else {
      const ref = parsePrRef(args.pr!);
      if (ref === undefined) throw new UsageError(`cannot parse --pr ${args.pr}; use owner/repo#123 or a PR URL`);
      prRef = ref;
      reader = new GhPrReader(ref.repo, ref.number, undefined, `ai-review/${args.name ?? "main"}`);
      if (!args["no-history"] || args.head !== undefined) history = new GhHistory(ref.repo);
      if (args.head !== undefined) {
        if (!/^[0-9a-f]{7,40}$/.test(args.head)) throw new UsageError(`invalid --head ${args.head}: give a commit SHA`);
        if (args["as-of"] !== undefined && Number.isNaN(Date.parse(args["as-of"]))) throw new UsageError(`invalid --as-of ${args["as-of"]}`);
        replay = new AtHeadReader(reader, history!, args.head, {
          ...(args["as-of"] === undefined ? {} : { asOf: args["as-of"] }),
          ...(args.quiet ? {} : { log: (line: string) => io.stderr(`[review-bot] ${line}\n`) }),
        });
        reader = replay;
      }
      snapshots = args["repo-dir"] !== undefined ? new GitArchiveSnapshots(resolve(args["repo-dir"])) : new GhTarballSnapshots(ref.repo);
    }
    let preparedCache: string | undefined;
    if (args["snapshot-dir"] !== undefined) {
      // Trees prepared by the CI prepare job (C-4); only the SHAs in its manifest are handed out.
      if (args["repo-dir"] !== undefined) throw new UsageError("give at most one of --repo-dir and --snapshot-dir");
      const prepared = new PreparedSnapshots(resolve(args["snapshot-dir"]));
      if (prRef !== undefined) prepared.assertFor(prRef.repo, prRef.number);
      snapshots = prepared;
      preparedCache = preparedModcache(prepared.dir, prepared.manifest);
      const m = prepared.manifest.modcache;
      if (preparedCache === undefined && !args.quiet) io.stderr(`[review-bot] no module cache from the prepare job: ${m.status}${m.detail ? ` (${m.detail})` : ""}\n`);
    }

    // The operator's agent directory (F-7). Read before anything runs: a
    // broken one is a configuration error, never "no configuration".
    let agentDir: string | undefined;
    let settings: AgentSettings | undefined;
    const agentDirArg = args["agent-dir"] ?? entry.defaultAgentDir;
    if (agentDirArg !== undefined) {
      agentDir = resolve(agentDirArg);
      try {
        settings = readAgentSettings(agentDir);
        // pi skips a listed package that is not installed (offline) and
        // goes on without it; for the bot that is a configuration error
        // (F-3). Loading them is R-1a step 4b. The read roots do not exist
        // yet: the given source directories and the runs directory stand in.
        if (settings.packages.length > 0) {
          const { SetupConfigError, verifyInstalled } = await import("../setup/index.ts");
          try {
            verifyInstalled({ agentDir, packages: settings.packages, forbiddenRoots: knownRoots(args) });
          } catch (e) {
            if (e instanceof SetupConfigError) throw new ConfigError(e.message);
            throw e;
          }
        }
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        io.stderr(`review-bot: configuration error: ${e.message}\n`);
        return 1;
      }
    }
    const { createAcpAgentStep, createModelRuntime, createPiSdkAgentStep, createRoutedAgentStep, createScriptedProvider } = await import("../agent/index.ts");
    const { runReview } = await import("../pipeline/run.ts");

    // Models: plain configuration, never a default (P-4).
    const models = pairs(args.model, "--model");
    const thinking = pairs(args.thinking, "--thinking");
    const providers = pairs(args.providers, "--providers");
    const inputs: ConfigInputs = { models: {}, thinking: {}, providers: {} };
    for (const [role, list] of providers) inputs.providers![role] = list.split(",").map((p) => p.trim()).filter((p) => p !== "");
    const acpAgents = readAcpAgents(args["acp-config"], args["acp-agent"]);
    let agentStep: AgentStep;
    let extraProviders: Parameters<typeof createModelRuntime>[0] = {};
    const withAgentDir = agentDir === undefined ? {} : { agentDir };
    if (args.script !== undefined) {
      const script = JSON.parse(readFileSync(resolve(args.script), "utf8")) as Script;
      const scripted = createScriptedProvider(script);
      for (const role of PIPELINE_ROLES) if (script[role] !== undefined && !models.has(role)) models.set(role, `scripted/${role}`);
      extraProviders = { providers: [scripted.provider] };
      agentStep = createPiSdkAgentStep({ ...extraProviders, ...withAgentDir, retry: { enabled: false } });
    } else {
      agentStep = createPiSdkAgentStep(withAgentDir);
    }
    if (Object.keys(acpAgents).length > 0) {
      agentStep = createRoutedAgentStep({ pi: agentStep, acp: createAcpAgentStep({ agents: acpAgents }) });
    } else {
      agentStep = createRoutedAgentStep({ pi: agentStep });
    }
    for (const [role, spec] of models) inputs.models![role] = spec;
    for (const [role, level] of thinking) {
      if (!(THINKING_LEVELS as readonly string[]).includes(level)) throw new UsageError(`invalid thinking level: ${level} (use ${THINKING_LEVELS.join(", ")})`);
      inputs.thinking![role] = level as ThinkingLevel;
    }
    if (args["max-cost"] !== undefined) {
      const usd = Number(args["max-cost"]);
      if (!(usd > 0)) throw new UsageError(`invalid --max-cost: ${args["max-cost"]}`);
      inputs.runCostUsd = usd;
    }
    if (args["include-drafts"]) inputs.skipDraft = false;
    applyTimeoutFlags(inputs, args["run-timeout"], args["max-run-timeout"], args["step-timeout"], args["idle-timeout"]);
    const waiting = args.waiting === undefined || args.waiting.trim() === "" ? undefined : parseWaiting(args.waiting);

    const modcache = args["no-modcache"]
      ? undefined
      : args.modcache !== undefined
        ? resolve(args.modcache)
        : args["snapshot-dir"] !== undefined
          ? preparedCache
          : defaultModcache();
    const knowledgeOverride = {
      ...(args["knowledge-dir"] === undefined ? {} : { dir: resolve(args["knowledge-dir"]) }),
      ...(args.guidelines === undefined ? {} : { guidelines: args.guidelines.map((g) => resolve(g)) }),
    };

    const log = args.quiet ? () => {} : (line: string) => io.stderr(`[review-bot] ${line}\n`);
    let platform: DryRunPlatform | GitHubPlatform;
    if (live) {
      const env = deps.env ?? process.env;
      let client;
      try {
        client = gitHubClientFromEnv(env, { log, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) });
      } catch (e) {
        throw new UsageError(e instanceof Error ? e.message : String(e));
      }
      const runUrl =
        env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
      platform = new GitHubPlatform({
        client,
        repo: prRef!.repo,
        number: prRef!.number,
        botId: `ai-review/${args.name ?? "main"}`,
        log,
        ...(runUrl === undefined ? {} : { detailsUrl: runUrl }),
      });
    } else {
      platform = new DryRunPlatform(reader);
    }

    const result = await runReview({
      platform,
      snapshots,
      agentStep,
      inputs,
      ...(agentDir === undefined || settings === undefined
        ? {}
        : { agent: { dir: agentDir, settings, models: () => createModelRuntime({ ...extraProviders, agentDir }) } }),
      ...(args.name === undefined ? {} : { name: args.name }),
      knowledgeOverride,
      ...(modcache === undefined ? {} : { modcache }),
      runsDir: runsDir(args),
      trigger: live ? entry.trigger : replay === undefined ? `${entry.trigger}-dry-run` : `${entry.trigger}-dry-run-replay`,
      ...(prRef === undefined ? {} : { prRef }),
      ...(waiting === undefined ? {} : { waiting }),
      ...(history === undefined || args["no-history"]
        ? {}
        : { history: { source: history, ...(replay === undefined ? {} : { asOf: () => replay.cutoff }) } }),
      ...(entry.signal === undefined ? {} : { signal: entry.signal }),
      log,
    });

    const payload = JSON.stringify(platform instanceof GitHubPlatform ? platform.report : platform.output, null, 2) + "\n";
    if (entry.printResult) io.stdout(payload);
    if (args.out !== undefined) writeFileSync(resolve(args.out), payload);
    log(`check ${result.conclusion}: ${result.checkSummary}`);
    if (result.runDir) log(`run directory ${result.runDir}`);
    return result.conclusion === "neutral" ? 1 : 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`${e.message}\n\n${usage}`);
      return 2;
    }
    throw e;
  }
}
