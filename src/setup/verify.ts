/**
 * The offline check in the review step (C-3a, C-4, F-7): pi skips a missing
 * package without failing, so each one is checked here. Reads files only:
 * no network and no process, not npm and not git.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { type AgentDir, assertOutsideRoots } from "./agent-dir.ts";
import { SetupConfigError } from "./errors.ts";
import { isRecord, readJsonObject } from "./files.ts";
import { lockedVersion, readProject } from "./project.ts";
import { inspectPackages, type Package, type PackagesInput } from "./sources.ts";

/** For the run record (A-6). */
export interface InstalledPackage {
  name: string;
  source: string;
  /** npm: the version. git: the commit. local: its package.json's, when it has one. */
  version?: string;
}

const RUN_SETUP = "run `review-bot setup` before the review (F-7)";

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

export function verifyInstalled(input: PackagesInput): InstalledPackage[] {
  const { dir, packages } = inspectPackages(input);
  return packages.map((pkg) => checkPackage(dir, pkg));
}

function checkPackage(dir: AgentDir, pkg: Package): InstalledPackage {
  const { source, path } = pkg;
  const problem = (reason: string) => new SetupConfigError(`package ${JSON.stringify(source)}: ${reason}`);
  if (!existsSync(path)) throw problem(`not installed at ${path}; ${RUN_SETUP}`);
  const isDirectory = statSync(path).isDirectory();
  if (!isDirectory && pkg.type !== "local") throw problem(`${path} is not a directory; ${RUN_SETUP}`);

  let manifest: Record<string, unknown> | undefined;
  if (isDirectory) {
    const file = join(path, "package.json");
    assertOutsideRoots(dir, file, `the package.json of ${JSON.stringify(source)}`);
    manifest = readJsonObject(file);
  }

  if (pkg.type === "npm") {
    if (manifest?.name !== pkg.name || manifest.version !== pkg.version) {
      throw problem(`${String(manifest?.name)}@${String(manifest?.version)} is installed, ${pkg.name}@${pkg.version} is pinned; ${RUN_SETUP}`);
    }
    return { name: pkg.name, source, version: pkg.version };
  }

  if (pkg.type === "git") {
    if (existsSync(join(dirname(path), `.${basename(path)}.pi-update-incomplete`))) {
      throw problem(`pi left an unfinished update; ${RUN_SETUP}`);
    }
    const head = join(path, ".git", "HEAD");
    // Detached, as both setup and pi leave a pinned checkout.
    const found = existsSync(head) ? readFileSync(head, "utf8").trim() : "no checkout";
    if (found !== pkg.commit) throw problem(`found ${found}, the pin is ${pkg.commit}; ${RUN_SETUP}`);
    const dependencies = manifest?.dependencies;
    const missing = isRecord(dependencies)
      ? Object.keys(dependencies).filter((name) => !existsSync(join(path, "node_modules", name)))
      : [];
    if (missing.length > 0) throw problem(`dependencies are not installed (${missing.join(", ")}); ${RUN_SETUP}`);
    return { name: text(manifest?.name) ?? pkg.name, source, version: pkg.commit };
  }

  checkLocked(dir, path, problem);
  const version = text(manifest?.version);
  return { name: text(manifest?.name) ?? basename(path), source, ...(version === undefined ? {} : { version }) };
}

/** A local source in the agent directory's `node_modules` is pinned by the lockfile. */
function checkLocked(dir: AgentDir, path: string, problem: (reason: string) => Error): void {
  const [top, first, second] = relative(dir.path, path).split(sep);
  if (top !== "node_modules" || first === undefined) return;
  const name = first.startsWith("@") && second !== undefined ? `${first}/${second}` : first;
  const project = readProject(dir.path);
  const locked = project === undefined ? undefined : lockedVersion(project, name);
  if (locked === undefined) throw problem(`${name} is not pinned by a lockfile in the agent directory (F-7)`);
  if (locked === null) return;
  const installed = readJsonObject(join(dir.path, "node_modules", name, "package.json"))?.version;
  if (installed !== locked) throw problem(`${name}@${String(installed)} is installed, the lockfile pins ${locked}; ${RUN_SETUP}`);
}
