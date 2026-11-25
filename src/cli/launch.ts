/**
 * The launcher: starts pi with the `/review-bot` command the way F-3's table
 * requires, for the action and the CLI (`review-bot launch`). It takes the
 * review's options (src/cli/review.ts) and hands them to the command.
 *
 * | pi's behaviour (F-3)                          | Here                                     |
 * |-----------------------------------------------|------------------------------------------|
 * | An unknown or ambiguous command is a prompt    | `-ne -e <pi-review>`: a missing path exits 1, nothing else loads to shadow it |
 * | pi waits while stdin is open                  | stdin is closed (`ignore`)               |
 * | Any module's handler can trust the project    | `--no-approve`, and an empty working directory |
 * | `console.log` goes to stderr                  | The result goes to `--out`, made absolute |
 *
 * Also: `--offline` and `PI_OFFLINE=1` (C-3a: nothing is downloaded where
 * secrets are), no skills, prompt templates, themes, context files or session
 * file for the parent pi, `safe.bareRepository=explicit` in its environment,
 * and SIGTERM, SIGINT and SIGHUP forwarded so the command can publish what
 * exists (S-9). The exit code is pi's, which the command sets.
 *
 * The parent pi's agent directory is always an empty private one, never the
 * runner's `~/.pi/agent` (C-3a). The command reads the operator's directory
 * from `--agent-dir` (F-7); without it, the same empty one.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireExplicitBareRepository } from "../core/git-env.ts";
import { assertIsolatedLocation } from "../platform/snapshot.ts";
import { quoteCommandArgs } from "./command-args.ts";
import { type Io, parseReviewArgs, REVIEW_OPTIONS, REVIEW_PATH_OPTIONS, UsageError } from "./review.ts";

export const LAUNCH_USAGE = `Launch (F-3):
  review-bot launch [review options]
                           The same review in pi, as the /review-bot command
                           of the pi-review package: pi from this install,
                           started with -ne -e <pi-review>, --no-approve,
                           --offline, stdin closed and an empty working
                           directory. Relative paths are made absolute.
                           Exit code: the command's (pi's own is not a
                           failure signal)
`;

/** The `pi-review` package directory of this checkout. */
export const PI_REVIEW_DIR = fileURLToPath(new URL("../../pi-review", import.meta.url));

/** pi's CLI from this install's node_modules (pinned, F-6), never one on PATH. */
export function piCliPath(): string {
  const main = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const cli = join(dirname(main), "bundle", "cli.js");
  if (!existsSync(cli)) throw new Error(`pi's CLI is not at ${cli}; run npm ci --ignore-scripts`);
  return cli;
}

export interface LaunchOptions {
  /** Environment for pi; default process.env. */
  env?: NodeJS.ProcessEnv;
  /** pi's cli.js; default `piCliPath()`. */
  piCli?: string;
  /** The package to load; default `PI_REVIEW_DIR`. Tests use a missing path. */
  packageDir?: string;
}

export interface PiLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Removes the working directory and the private agent directory. */
  cleanup(): void;
}

class LaunchConfigError extends Error {}

/** The review's arguments with every path made absolute, in a canonical order. */
export function absoluteReviewArgs(argv: readonly string[]): string[] {
  const values = parseReviewArgs(argv) as Record<string, string | boolean | string[] | undefined>;
  const paths = new Set<string>(REVIEW_PATH_OPTIONS);
  const out: string[] = [];
  for (const name of Object.keys(REVIEW_OPTIONS)) {
    const value = values[name];
    if (value === undefined || value === false) continue;
    if (value === true) {
      out.push(`--${name}`);
      continue;
    }
    for (const v of Array.isArray(value) ? value : [value]) out.push(`--${name}`, paths.has(name) ? resolve(v) : v);
  }
  return out;
}

/** Everything needed to start pi; creates the empty directories. Throws UsageError or LaunchConfigError. */
export function prepareLaunch(argv: readonly string[], options: LaunchOptions = {}): PiLaunch {
  const reviewArgs = absoluteReviewArgs(argv);
  const given = parseReviewArgs(reviewArgs)["agent-dir"];
  const temp = realpathSync(tmpdir());
  const created: string[] = [];
  const cleanup = () => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  };
  try {
    // C-3a: the parent pi's working directory is empty and has no .git or
    // context file above it, so neither pi nor a module finds configuration there.
    const cwd = mkdtempSync(join(temp, "review-bot-pi-cwd-"));
    created.push(cwd);
    try {
      assertIsolatedLocation(cwd);
    } catch {
      throw new LaunchConfigError(`the temporary directory ${temp} has a .git entry or a context file in or above it (C-3a); set TMPDIR to another directory`);
    }
    // The parent pi's own agent directory is always a private empty one: it
    // loads nothing from it (-ne), and pi locks settings.json even to read it,
    // which fails on the read-only operator directory the action mounts
    // ("Invalid settings file ... EROFS"). The command reads the operator's
    // directory itself, given as --agent-dir (F-7, C-3a).
    const piAgentDir = mkdtempSync(join(temp, "review-bot-pi-agent-"));
    created.push(piAgentDir);
    if (given === undefined) reviewArgs.push("--agent-dir", piAgentDir);
    const env: NodeJS.ProcessEnv = {
      ...(options.env ?? process.env),
      PI_CODING_AGENT_DIR: piAgentDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    };
    requireExplicitBareRepository(env);
    const args = [
      options.piCli ?? piCliPath(),
      // Only our package, by path: a missing path exits 1, and no other
      // module can register a command that shadows /review-bot (F-3).
      "-ne",
      "-e",
      options.packageDir ?? PI_REVIEW_DIR,
      "-ns",
      "-np",
      "--no-themes",
      "-nc",
      "-na",
      "--offline",
      "--no-session",
      "-p",
      `/review-bot ${quoteCommandArgs(reviewArgs)}`,
    ];
    return { command: process.execPath, args, cwd, env, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

/** `review-bot launch`: run pi with the command; resolves to its exit code. */
export async function runLaunch(argv: readonly string[], io: Io, options: LaunchOptions = {}): Promise<number> {
  let launch: PiLaunch;
  try {
    launch = prepareLaunch(argv, options);
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`${e.message}\n\n${LAUNCH_USAGE}`);
      return 2;
    }
    if (e instanceof LaunchConfigError) {
      io.stderr(`review-bot: configuration error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
  try {
    return await new Promise<number>((done, fail) => {
      const child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        // F-3: pi waits while stdin is open.
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.setEncoding("utf8").on("data", (t: string) => io.stdout(t));
      child.stderr.setEncoding("utf8").on("data", (t: string) => io.stderr(t));
      let exited: number | undefined;
      let streams = 2;
      const settle = () => {
        if (exited !== undefined && streams === 0) done(exited);
      };
      for (const stream of [child.stdout, child.stderr]) {
        stream.once("close", () => {
          streams--;
          settle();
        });
      }
      const forward = (signal: NodeJS.Signals) => () => void child.kill(signal);
      const handlers = SIGNALS.map((s) => [s, forward(s)] as const);
      for (const [s, h] of handlers) process.on(s, h);
      const stop = () => {
        for (const [s, h] of handlers) process.off(s, h);
      };
      child.once("error", (e) => {
        stop();
        fail(e);
      });
      child.once("exit", (code, signal) => {
        stop();
        exited = code ?? 128 + (SIGNAL_NUMBERS[signal ?? ""] ?? 0);
        settle();
      });
    });
  } finally {
    launch.cleanup();
  }
}
