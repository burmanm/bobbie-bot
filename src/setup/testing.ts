/** Fixtures for the setup tests: local tarballs and repositories, no network. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after } from "node:test";
import { type CommandOptions, type CommandRunner, runCommand } from "./installer.ts";

/** A directory removed when the test file ends. */
export function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-setup-test-")));
  after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

export function write(path: string, content: string | object, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  writeFileSync(path, text, mode === undefined ? {} : { mode });
}

export function layout(parent: string) {
  const root = mkdtempSync(join(parent, "case-"));
  const agentDir = join(root, "agent");
  const head = join(root, "work", "head");
  const base = join(root, "work", "base");
  for (const dir of [agentDir, head, base]) mkdirSync(dir, { recursive: true });
  return { root, agentDir, head, base, marker: join(root, "marker"), forbiddenRoots: [head, base] };
}

/**
 * The environment for building fixtures and for the controls: no user
 * configuration and no network, but none of setup's protections.
 */
export function plainEnv(dir: string): Record<string, string> {
  const at = (name: string) => join(dir, ".fixture", name);
  for (const name of ["home", "cache"]) mkdirSync(at(name), { recursive: true });
  for (const name of ["user.npmrc", "global.npmrc"]) writeFileSync(at(name), "");
  return {
    PATH: [dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
    HOME: at("home"),
    npm_config_userconfig: at("user.npmrc"),
    npm_config_globalconfig: at("global.npmrc"),
    npm_config_cache: at("cache"),
    npm_config_update_notifier: "false",
    ...NO_NETWORK,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

const NO_NETWORK = {
  npm_config_offline: "true",
  GIT_ALLOW_PROTOCOL: "file",
  HTTPS_PROXY: "http://127.0.0.1:9",
  HTTP_PROXY: "http://127.0.0.1:9",
};

export function sh(dir: string, command: string, args: readonly string[], cwd = dir): string {
  return execFileSync(command, args, { cwd, env: plainEnv(dir), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }).trim();
}

/** Scripts that each append their own name to `marker`. */
export function markerScripts(marker: string, label: string, events = ["preinstall", "install", "postinstall", "prepare"]) {
  return Object.fromEntries(events.map((event) => [event, `echo ${label}:${event} >> "${marker}"`]));
}

export function marks(marker: string): string {
  return existsSync(marker) ? readFileSync(marker, "utf8") : "";
}

export const EXTENSION = "export default function () {}\n";

export function piPackage(dir: string, manifest: Record<string, unknown>): void {
  write(join(dir, "package.json"), { pi: { extensions: ["./index.ts"] }, ...manifest });
  write(join(dir, "index.ts"), EXTENSION);
}

export function tarball(root: string, manifest: Record<string, unknown>): string {
  const dir = mkdtempSync(join(root, "pack-"));
  piPackage(dir, manifest);
  const name = sh(root, "npm", ["pack", "--ignore-scripts", "--silent"], dir);
  return join(dir, name);
}

export function gitRepo(root: string, fill: (dir: string) => void): { dir: string; commit: string } {
  const dir = mkdtempSync(join(root, "repo-"));
  sh(root, "git", ["-C", dir, "init", "--quiet"]);
  fill(dir);
  return { dir, commit: commitAll(root, dir) };
}

export function commitAll(root: string, dir: string): string {
  sh(root, "git", ["-C", dir, "add", "--all"]);
  sh(root, "git", ["-C", dir, "-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
  return sh(root, "git", ["-C", dir, "rev-parse", "HEAD"]);
}

export interface Call {
  command: string;
  args: readonly string[];
  options: CommandOptions;
}

/**
 * The real runner, kept offline. `local` maps a registry spec or an https
 * URL to the fixture standing in for it; everything else runs as given.
 */
export function offlineRunner(local: Record<string, string> = {}) {
  const calls: Call[] = [];
  const run: CommandRunner = (command, args, options) => {
    calls.push({ command, args, options });
    return runCommand(command, args.map((arg) => local[arg] ?? arg), { ...options, env: { ...options.env, ...NO_NETWORK } });
  };
  return { calls, run };
}
