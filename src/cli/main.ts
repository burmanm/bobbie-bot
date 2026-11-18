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
import { type AgentStep, createPiSdkAgentStep, createScriptedProvider, type Script, type ThinkingLevel } from "../agent/index.ts";
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
import { type ConfigInputs, PIPELINE_ROLES, type PipelineRole, runReview } from "../pipeline/index.ts";

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
  --model <role>=<provider>/<id>   role is reviewer or verifier (repeatable)
  --thinking <role>=<level>        off, minimal, low, medium, high
  --script <file>          Use a scripted model (JSON) instead of a provider

Run:
  --name <name>            Reviewer name; check run ai-review/<name> (default main)
  --modcache <dir>         Dependency source cache (default: Go module cache if present)
  --no-modcache            Do not offer a dependency source cache
  --runs-dir <dir>         Parent of the run directory (default: <tmp>/review-bot-runs)
  --max-cost <usd>         Run spend cap
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
        script: { type: "string" },
        name: { type: "string" },
        modcache: { type: "string" },
        "no-modcache": { type: "boolean" },
        "runs-dir": { type: "string" },
        "max-cost": { type: "string" },
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
    if (args.fixture !== undefined) {
      const fixture = new FixturePrReader(resolve(args.fixture));
      reader = fixture;
      snapshots = fixture.snapshots();
    } else {
      const ref = parsePrRef(args.pr!);
      if (ref === undefined) throw new UsageError(`cannot parse --pr ${args.pr}; use owner/repo#123 or a PR URL`);
      reader = new GhPrReader(ref.repo, ref.number);
      snapshots = args["repo-dir"] !== undefined ? new GitArchiveSnapshots(resolve(args["repo-dir"])) : new GhTarballSnapshots(ref.repo);
    }

    // Models: plain configuration, never a default (P-4).
    const models = pairs(args.model, "--model");
    const thinking = pairs(args.thinking, "--thinking");
    const inputs: ConfigInputs = { models: {}, thinking: {} };
    let agentStep: AgentStep;
    if (args.script !== undefined) {
      const script = JSON.parse(readFileSync(resolve(args.script), "utf8")) as Script;
      const scripted = createScriptedProvider(script);
      for (const role of PIPELINE_ROLES) if (script[role] !== undefined && !models.has(role)) models.set(role, `scripted/${role}`);
      agentStep = createPiSdkAgentStep({ providers: [scripted.provider], retry: { enabled: false } });
    } else {
      agentStep = createPiSdkAgentStep();
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
