/**
 * How `setup` runs npm, pnpm and git (C-4, F-7): in an empty directory of
 * our own, stdin closed, under a timeout, with an environment built from an
 * allowlist.
 *
 * `--ignore-scripts` alone does not stop npm from running a package's code.
 * To prepare a git dependency npm runs a second npm inside that clone,
 * which obeys the clone's `.npmrc`: `git=./program` there is executed with
 * scripts off (seen with npm 11.12.1). Environment configuration outranks a
 * project `.npmrc`, so the settings that name programs are set here.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { AgentDir } from "./agent-dir.ts";
import { followLinks, isWithin } from "./files.ts";

export interface CommandOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Aborting kills the command's whole process group, as the timeout does. */
  signal?: AbortSignal;
}

export interface CommandResult {
  code: number | null;
  timedOut: boolean;
  /** The end of stdout and stderr together. */
  output: string;
}

export type CommandRunner = (command: string, args: readonly string[], options: CommandOptions) => Promise<CommandResult>;

/** Copied from the caller. Everything else, every key and token included, is dropped. */
const PASSED = ["LANG", "LC_ALL", "LC_CTYPE", "TZ", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"];
/** Copied only without credentials in them. */
const PROXIES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];

const GIT_CONFIG: readonly (readonly [string, string])[] = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["safe.bareRepository", "explicit"],
  ["credential.helper", ""],
  // Detached maintenance would outlive the command.
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
  // npm records public GitHub dependencies as ssh, and setup has no ssh key.
  ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
  ["url.https://github.com/.insteadOf", "git@github.com:"],
];

/**
 * The environment of every installer. `work` is a private, empty directory:
 * it holds HOME, caches and the empty user and global npm configuration, so
 * the runner's `~/.npmrc`, `.netrc`, git credentials and ssh keys stay out.
 */
export function installerEnv(from: NodeJS.ProcessEnv, work: string, dir: AgentDir): Record<string, string> {
  const at = (name: string) => join(work, name);
  for (const name of ["home", "tmp", "cache", "logs"]) mkdirSync(at(name));
  for (const name of ["user.npmrc", "global.npmrc"]) writeFileSync(at(name), "");

  // npm ships beside node. No relative entry, and none that is in a read root.
  const path = [dirname(process.execPath), ...(from.PATH ?? "").split(delimiter)]
    .filter((entry) => isAbsolute(entry) && !dir.forbidden.some((root) => isWithin(root.real, followLinks(entry))))
    .join(delimiter);

  const env: Record<string, string> = {
    PATH: path,
    HOME: at("home"),
    TMPDIR: at("tmp"),
    CI: "true",

    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CEILING_DIRECTORIES: dirname(work),
    GIT_TERMINAL_PROMPT: "0",
    // ssh takes keys from the account's home directory, whatever HOME says.
    GIT_SSH_COMMAND: "false",
    GIT_CONFIG_COUNT: String(GIT_CONFIG.length),

    npm_config_userconfig: at("user.npmrc"),
    npm_config_globalconfig: at("global.npmrc"),
    npm_config_cache: at("cache"),
    npm_config_logs_dir: at("logs"),
    npm_config_update_notifier: "false",
    npm_config_ignore_scripts: "true",
    npm_config_git: "git",
    npm_config_script_shell: "/bin/sh",
    // Not empty: npm ignores empty variables, and the project's value would win.
    npm_config_node_options: "--no-warnings",
    npm_config_global: "false",
    npm_config_location: "project",

    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
  };
  for (const [i, [key, value]] of GIT_CONFIG.entries()) {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  }
  for (const name of PASSED) {
    const value = from[name];
    if (value) env[name] = value;
  }
  for (const name of PROXIES) {
    const value = from[name];
    if (value && !value.includes("@")) env[name] = value;
  }
  return env;
}

/** pnpm reads npm's variables up to v10 and its own from v11. */
export function pnpmEnv(env: Record<string, string>): Record<string, string> {
  return {
    ...env,
    npm_config_manage_package_manager_versions: "false",
    pnpm_config_pm_on_fail: "ignore",
    pnpm_config_ignore_scripts: "true",
    pnpm_config_ignore_pnpmfile: "true",
  };
}

const OUTPUT_LIMIT = 16_384;
/** After exit, how long to wait for a grandchild to let go of the pipes. */
const DRAIN_MS = 2_000;

export const runCommand: CommandRunner = (command, args, { cwd, env, timeoutMs, signal }) =>
  new Promise((done) => {
    if (signal?.aborted) {
      done({ code: null, timedOut: false, output: "cancelled before it started" });
      return;
    }
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    let finished = false;
    let code: number | null = null;
    let drain: NodeJS.Timeout | undefined;

    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The whole group has already exited.
      }
    };
    // Installers are detached (their own process group) so that the group
    // can be killed; Ctrl-C at the terminal therefore no longer reaches them.
    const onAbort = () => killGroup();
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(deadline);
      clearTimeout(drain);
      child.stdout.destroy();
      child.stderr.destroy();
      done({ code, timedOut, output });
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8").on("data", (data: string) => {
        output = (output + data).slice(-OUTPUT_LIMIT);
      });
    }
    child.on("error", (error) => {
      output += error.message;
      finish();
    });
    child.on("exit", (exitCode) => {
      code = exitCode;
      clearTimeout(deadline);
      // Nothing an installer started may keep running into the review.
      killGroup();
      drain = setTimeout(finish, DRAIN_MS);
    });
    child.on("close", finish);
  });
