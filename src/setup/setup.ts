/**
 * Installing the operator's packages (F-7, C-4, R-1a step 4): run in a step
 * with no secrets, before the review runs with `PI_OFFLINE=1`.
 *
 * Not through pi's package manager: its install arguments leave lifecycle
 * scripts on and it hands installers the whole environment. The result is
 * pi's layout (`npm/node_modules`, `git/<host>/<path>`), so pi finds it.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type AgentDir, assertOutsideRoots } from "./agent-dir.ts";
import { PackageInstallError, SetupConfigError } from "./errors.ts";
import { followLinks, isWithin } from "./files.ts";
import { type CommandRunner, installerEnv, pnpmEnv, runCommand } from "./installer.ts";
import { type Project, readProject } from "./project.ts";
import { inspectPackages, type Package, type PackagesInput } from "./sources.ts";
import { type InstalledPackage, verifyInstalled } from "./verify.ts";

export interface SetupOptions extends PackagesInput {
  /** Per command. */
  timeoutMs?: number;
  /** Where the allowlisted variables are copied from. */
  env?: NodeJS.ProcessEnv;
  run?: CommandRunner;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const NO_SCRIPTS = "--ignore-scripts";
const QUIET = ["--no-audit", "--no-fund"];
/** As pi installs: the host supplies the `@earendil-works/pi-*` peers. */
const PI_PEERS = "--legacy-peer-deps";

type Exec = (command: "npm" | "pnpm" | "git", args: readonly string[]) => Promise<void>;
type GitPackage = Extract<Package, { type: "git" }>;
type NpmPackage = Extract<Package, { type: "npm" }>;

export async function setupPackages(options: SetupOptions): Promise<InstalledPackage[]> {
  const { dir, packages } = inspectPackages(options);
  const project = readProject(dir.path);
  const npm = packages.filter((p): p is NpmPackage => p.type === "npm");
  const git = packages.filter((p): p is GitPackage => p.type === "git");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!(timeoutMs > 0)) throw new SetupConfigError("timeoutMs must be positive");

  // Setup deletes and replaces what is at these paths.
  const destinations = [
    ...(project === undefined ? [] : ["node_modules"]),
    ...(npm.length === 0 ? [] : ["npm", "npm/node_modules", "npm/package.json", "npm/package-lock.json"]),
    ...(git.length === 0 ? [] : ["git"]),
  ].map((name) => join(dir.path, name));
  for (const path of [...destinations, ...git.map((p) => p.path)]) assertInAgentDir(dir, path);

  if (project !== undefined || npm.length > 0 || git.length > 0) {
    const work = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-setup-")));
    try {
      assertOutsideRoots(dir, work, "setup's working directory");
      const exec = createExec(dir, work, timeoutMs, options.env ?? process.env, options.run ?? runCommand);
      if (project !== undefined) await installProject(dir, project, work, exec);
      if (npm.length > 0) await installNpm(dir, npm, exec);
      for (const pkg of git) await installGit(dir, pkg, exec);
    } finally {
      rmSync(work, { recursive: true, force: true, maxRetries: 3 });
    }
  }
  return verifyInstalled(options);
}

function assertInAgentDir(dir: AgentDir, path: string): void {
  const real = followLinks(path);
  if (real === dir.real || !isWithin(dir.real, real)) {
    throw new SetupConfigError(`setup would write to ${real}, outside the agent directory, through ${path}`);
  }
}

function createExec(dir: AgentDir, work: string, timeoutMs: number, from: NodeJS.ProcessEnv, run: CommandRunner): Exec {
  const env = installerEnv(from, work, dir);
  const cwd = join(work, "cwd");
  mkdirSync(cwd);
  return async (command, args) => {
    const result = await run(command, args, { cwd, env: command === "pnpm" ? pnpmEnv(env) : env, timeoutMs });
    if (result.code === 0 && !result.timedOut) return;
    const reason = result.timedOut ? `timed out after ${timeoutMs} ms` : `failed with exit code ${result.code ?? "none"}`;
    throw new PackageInstallError(`${command} ${args.join(" ")} ${reason}\n${result.output.trim()}`.trim());
  };
}

async function installProject(dir: AgentDir, project: Project, work: string, exec: Exec): Promise<void> {
  if (project.manager === "npm") {
    await exec("npm", ["ci", "--prefix", dir.real, NO_SCRIPTS, "--omit=dev", ...QUIET]);
    return;
  }
  await exec("pnpm", [
    "install",
    "--frozen-lockfile",
    NO_SCRIPTS,
    // `.pnpmfile.cjs` is code that runs at install time.
    "--ignore-pnpmfile",
    // Without a workspace file of its own, pnpm would install the enclosing one.
    ...(existsSync(join(dir.real, "pnpm-workspace.yaml")) ? [] : ["--ignore-workspace"]),
    "--prod",
    "--dir",
    dir.real,
    "--store-dir",
    join(work, "pnpm-store"),
  ]);
}

async function installNpm(dir: AgentDir, packages: readonly NpmPackage[], exec: Exec): Promise<void> {
  const root = join(dir.real, "npm");
  mkdirSync(root, { recursive: true });
  ignoreContents(root);
  const manifest = join(root, "package.json");
  if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ name: "pi-extensions", private: true }, null, 2));
  // --prefix through a symlink gives broken lockfile paths, hence the real path.
  const specs = packages.map((p) => `${p.name}@${p.version}`);
  await exec("npm", ["install", ...specs, "--prefix", realpathSync(root), NO_SCRIPTS, "--save-exact", PI_PEERS, ...QUIET]);
}

/** Into a staging directory, so a failure never leaves half a package in place. */
async function installGit(dir: AgentDir, pkg: GitPackage, exec: Exec): Promise<void> {
  const root = join(dir.real, "git");
  mkdirSync(root, { recursive: true });
  ignoreContents(root);
  const staging = mkdtempSync(join(realpathSync(root), ".setup-"));
  try {
    const clone = join(staging, "clone");
    // A clone, not a fetch of the SHA: GitHub also serves commits that exist only in a fork.
    await exec("git", ["clone", "--quiet", "--no-checkout", "--template=", "--", pkg.repo, clone]);
    await exec("git", ["-C", clone, "checkout", "--quiet", "--detach", pkg.commit, "--"]);
    const head = readFileSync(join(clone, ".git", "HEAD"), "utf8").trim();
    // 64 hex digits can name a tag in a SHA-1 repository, 40 abbreviate in a SHA-256 one.
    if (head !== pkg.commit) {
      throw new SetupConfigError(`package ${JSON.stringify(pkg.source)}: the pin is not a commit, it resolved to ${head} (F-7)`);
    }
    if (existsSync(join(clone, "package.json"))) {
      await exec("npm", ["install", "--prefix", clone, NO_SCRIPTS, "--omit=dev", PI_PEERS, ...QUIET]);
    }
    mkdirSync(dirname(pkg.path), { recursive: true });
    const target = followLinks(pkg.path);
    if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) renameSync(target, join(staging, "previous"));
    renameSync(clone, target);
    rmSync(join(dirname(target), `.${basename(target)}.pi-update-incomplete`), { force: true });
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** pi's `.gitignore` for the directories it manages. */
function ignoreContents(root: string): void {
  const file = join(root, ".gitignore");
  if (lstatSync(file, { throwIfNoEntry: false }) === undefined) writeFileSync(file, "*\n!.gitignore\n");
}
