/** The `package.json` and lockfile next to the operator's settings (F-7, way 2). */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { SetupConfigError } from "./errors.ts";
import { isRecord, readJsonObject } from "./files.ts";

export interface Project {
  manager: "npm" | "pnpm";
  lockfile: string;
}

const LOCKFILES = [
  ["npm-shrinkwrap.json", "npm"],
  ["package-lock.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
] as const;

const declares = (value: unknown): boolean => isRecord(value) && Object.keys(value).length > 0;

/** Undefined when the directory has nothing to install. */
export function readProject(agentDir: string): Project | undefined {
  const manifest = readJsonObject(join(agentDir, "package.json"));
  if (manifest === undefined) return undefined;
  if (!declares(manifest.dependencies) && !declares(manifest.optionalDependencies)) return undefined;
  const found = LOCKFILES.filter(([name]) => existsSync(join(agentDir, name)));
  const [first] = found;
  if (first === undefined) {
    throw new SetupConfigError("the agent directory's package.json needs a committed package-lock.json or pnpm-lock.yaml (F-7)");
  }
  if (found.length > 1) {
    throw new SetupConfigError(`the agent directory has more than one lockfile: ${found.map(([name]) => name).join(", ")}`);
  }
  return { manager: first[1], lockfile: join(agentDir, first[0]) };
}

/**
 * The version the lockfile pins for a top-level installed package. `null`
 * for one that has no version of its own there (a link or a file).
 */
export function lockedVersion(project: Project, name: string): string | null | undefined {
  if (project.manager === "npm") {
    const packages = readJsonObject(project.lockfile)?.packages;
    if (!isRecord(packages)) throw new SetupConfigError(`${project.lockfile} must have lockfileVersion 2 or later`);
    const entry = packages[`node_modules/${name}`];
    if (!isRecord(entry)) return undefined;
    return typeof entry.version === "string" ? entry.version : null;
  }
  let doc: unknown;
  try {
    doc = parse(readFileSync(project.lockfile, "utf8"));
  } catch {
    throw new SetupConfigError(`${project.lockfile} is not valid YAML`);
  }
  if (!isRecord(doc)) return undefined;
  // `importers["."]`, or the document itself in a single-project v6 lockfile.
  const root = isRecord(doc.importers) ? doc.importers["."] : doc;
  if (!isRecord(root)) return undefined;
  for (const section of [root.dependencies, root.optionalDependencies]) {
    if (!isRecord(section) || !Object.hasOwn(section, name)) continue;
    const entry = section[name];
    const version = isRecord(entry) ? entry.version : entry;
    // `1.2.3`, `1.2.3(peer@4.5.6)` or an alias `real@1.2.3`.
    return /^(?:@?[^@(:]+@)?(\d+\.\d+\.\d+[^(]*)(?:\(.*)?$/.exec(String(version))?.[1] ?? null;
  }
  return undefined;
}
