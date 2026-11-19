#!/usr/bin/env node
/**
 * `review-bot` CLI (A-2). R-1 has one command, a dry run:
 *
 *   review-bot review --dry-run --pr <owner/repo#N> [options]
 *   review-bot review --dry-run --fixture <dir> [--script <file>] [options]
 *
 * It reads the PR (GitHub read-only through `gh`, or a fixture), runs the
 * pipeline, and prints the would-be review instead of posting it. Logs go to
 * stderr; the payload JSON goes to stdout and, with --out, to a file.
 *
 * Exit codes: 0 reviewed or skipped, 1 could not complete (neutral check),
 * 2 usage error.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  type AcpAgentConfig,
  type AgentStep,
  createAcpAgentStep,
  createPiSdkAgentStep,
  createRoutedAgentStep,
  createScriptedProvider,
  type Script,
  type ThinkingLevel,
} from "../agent/index.ts";
import {
  defaultModcache,
  DryRunPlatform,
  FixturePrReader,
  GhPrReader,
  GhTarballSnapshots,
  GitArchiveSnapshots,
  parsePrRef,
  type PrReader,
  type SnapshotSource,
} from "../platform/index.ts";
import { type ConfigInputs, parseDuration, PIPELINE_ROLES, type PipelineRole, runReview } from "../pipeline/index.ts";

const USAGE = `Usage:
  review-bot review --dry-run --pr <owner/repo#N | PR URL> [options]
  review-bot review --dry-run --fixture <dir> [options]

Source:
  --pr <ref>               Read the PR from GitHub, read-only, through gh
  --repo-dir <dir>         Extract trees with git archive from this clone
                           (default with --pr: download tarballs through gh)
  --fixture <dir>          Read the PR from a fixture directory

Knowledge (default: AGENTS.md, REVIEW.md, .review/*-guidelines.md from the base tree):
  --knowledge-dir <dir>    Read AGENTS.md, REVIEW.md, .review/ from here instead
  --guidelines <file>      Add a guidelines file (repeatable)

Models (no defaults; .review/review-bot.yaml on the base branch overrides):
  --model <role>=<provider>/<id>   role is reviewer or verifier (repeatable).
                                   provider "openrouter" runs in pi;
                                   "acp/<agent>" runs an ACP agent (below)
  --thinking <role>=<level>        off, minimal, low, medium, high
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
  --step-timeout [<role>=]<duration>  Per-step wall-clock limit (default
                           reviewer 20m, verifier 8m); no role = both roles
  --idle-timeout [<role>=]<duration>  Stop a step after this long with no
                           model output or tool activity (default 3m)
                           Durations: 90s, 20m, 1.5h; a bare number is seconds.
                           .review/review-bot.yaml on the base branch overrides
  --include-drafts         Review draft PRs too
  --out <file>             Also write the would-be review JSON here
  --quiet                  No progress log on stderr
`;

class UsageError extends Error {}

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

/** --run-timeout, --step-timeout and --idle-timeout into the config inputs (S-4 Limits). */
function applyTimeoutFlags(inputs: ConfigInputs, run: string | undefined, step: string[] | undefined, idle: string[] | undefined): void {
  const duration = (flag: string, text: string): number => {
    const ms = parseDuration(text);
    if (ms === undefined) throw new UsageError(`invalid ${flag}: ${text} (use for example 90s, 20m or 1.5h)`);
    return ms;
  };
  if (run !== undefined) inputs.runTimeoutMs = duration("--run-timeout", run);
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

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
}

const processIo: Io = {
  stdout: (t) => void process.stdout.write(t),
  stderr: (t) => void process.stderr.write(t),
};

export async function main(argv: string[], io: Io = processIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    io.stdout(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command !== "review") {
    io.stderr(`unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }

  let args;
  try {
    args = parseArgs({
      args: rest,
      options: {
        "dry-run": { type: "boolean" },
        pr: { type: "string" },
        "repo-dir": { type: "string" },
        fixture: { type: "string" },
        "knowledge-dir": { type: "string" },
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
        "step-timeout": { type: "string", multiple: true },
        "idle-timeout": { type: "string", multiple: true },
        "include-drafts": { type: "boolean" },
        out: { type: "string" },
        quiet: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (e) {
    io.stderr(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    io.stdout(USAGE);
    return 0;
  }

  try {
    if (!args["dry-run"]) throw new UsageError("only --dry-run is supported in R-1: nothing is ever posted to GitHub");
    if ((args.pr === undefined) === (args.fixture === undefined)) throw new UsageError("give exactly one of --pr and --fixture");
    if (args.name !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(args.name)) throw new UsageError(`invalid --name: ${args.name}`);

    // PR source and snapshots.
    let reader: PrReader;
    let snapshots: SnapshotSource;
    let prRef: { repo: string; number: number } | undefined;
    if (args.fixture !== undefined) {
      const fixture = new FixturePrReader(resolve(args.fixture));
      reader = fixture;
      snapshots = fixture.snapshots();
    } else {
      const ref = parsePrRef(args.pr!);
      if (ref === undefined) throw new UsageError(`cannot parse --pr ${args.pr}; use owner/repo#123 or a PR URL`);
      prRef = ref;
      reader = new GhPrReader(ref.repo, ref.number);
      snapshots = args["repo-dir"] !== undefined ? new GitArchiveSnapshots(resolve(args["repo-dir"])) : new GhTarballSnapshots(ref.repo);
    }

    // Models: plain configuration, never a default (P-4).
    const models = pairs(args.model, "--model");
    const thinking = pairs(args.thinking, "--thinking");
    const providers = pairs(args.providers, "--providers");
    const inputs: ConfigInputs = { models: {}, thinking: {}, providers: {} };
    for (const [role, list] of providers) inputs.providers![role] = list.split(",").map((p) => p.trim()).filter((p) => p !== "");
    const acpAgents = readAcpAgents(args["acp-config"], args["acp-agent"]);
    let agentStep: AgentStep;
    if (args.script !== undefined) {
      const script = JSON.parse(readFileSync(resolve(args.script), "utf8")) as Script;
      const scripted = createScriptedProvider(script);
      for (const role of PIPELINE_ROLES) if (script[role] !== undefined && !models.has(role)) models.set(role, `scripted/${role}`);
      agentStep = createPiSdkAgentStep({ providers: [scripted.provider], retry: { enabled: false } });
    } else {
      agentStep = createPiSdkAgentStep();
    }
    if (Object.keys(acpAgents).length > 0) {
      agentStep = createRoutedAgentStep({ pi: agentStep, acp: createAcpAgentStep({ agents: acpAgents }) });
    } else {
      agentStep = createRoutedAgentStep({ pi: agentStep });
    }
    for (const [role, spec] of models) inputs.models![role] = spec;
    for (const [role, level] of thinking) {
      if (!["off", "minimal", "low", "medium", "high"].includes(level)) throw new UsageError(`invalid thinking level: ${level}`);
      inputs.thinking![role] = level as ThinkingLevel;
    }
    if (args["max-cost"] !== undefined) {
      const usd = Number(args["max-cost"]);
      if (!(usd > 0)) throw new UsageError(`invalid --max-cost: ${args["max-cost"]}`);
      inputs.runCostUsd = usd;
    }
    if (args["include-drafts"]) inputs.skipDraft = false;
    applyTimeoutFlags(inputs, args["run-timeout"], args["step-timeout"], args["idle-timeout"]);

    const modcache = args["no-modcache"] ? undefined : args.modcache !== undefined ? resolve(args.modcache) : defaultModcache();
    const knowledgeOverride = {
      ...(args["knowledge-dir"] === undefined ? {} : { dir: resolve(args["knowledge-dir"]) }),
      ...(args.guidelines === undefined ? {} : { guidelines: args.guidelines.map((g) => resolve(g)) }),
    };

    const platform = new DryRunPlatform(reader);
    const controller = new AbortController();
    const onSignal = () => controller.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    const log = args.quiet ? () => {} : (line: string) => io.stderr(`[review-bot] ${line}\n`);

    const result = await runReview({
      platform,
      snapshots,
      agentStep,
      inputs,
      ...(args.name === undefined ? {} : { name: args.name }),
      knowledgeOverride,
      ...(modcache === undefined ? {} : { modcache }),
      runsDir: resolve(args["runs-dir"] ?? join(tmpdir(), "review-bot-runs")),
      trigger: "cli-dry-run",
      ...(prRef === undefined ? {} : { prRef }),
      signal: controller.signal,
      log,
    });
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);

    const payload = JSON.stringify(platform.output, null, 2) + "\n";
    io.stdout(payload);
    if (args.out !== undefined) writeFileSync(resolve(args.out), payload);
    log(`check ${result.conclusion}: ${result.checkSummary}`);
    if (result.runDir) log(`run directory ${result.runDir}`);
    return result.conclusion === "neutral" ? 1 : 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
}

// Run when executed directly (import.meta.main is not in every supported Node 22).
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`review-bot: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
