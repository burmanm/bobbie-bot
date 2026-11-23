/**
 * The operator's pi packages for one step (F-7, C-3a, R-1a step 4b).
 *
 * Exactly the packages listed in the agent directory's `settings.json`, as
 * installed by `review-bot setup`: checked offline first (`verifyInstalled`:
 * files only, no npm or git), then resolved with pi's own package manager so
 * the manifest (`pi.extensions`) and per-package filters mean what they mean
 * in pi. Nothing is auto-discovered: the agent directory's own `extensions/`,
 * `skills/`, `prompts/` and `themes/`, its top-level `extensions` setting and
 * pi's built-ins are dropped, and so is everything from the snapshot and the
 * runner's `~/.pi/agent` (the session never sees either directory).
 *
 * Every resource a package declares must resolve, through symlinks, outside
 * the read roots: a manifest entry or a link inside the package can point
 * into the snapshot, and loading from there would execute the PR (D-19).
 */
import { realpathSync } from "node:fs";
import { DefaultPackageManager, type PackageSource, SettingsManager } from "@earendil-works/pi-coding-agent";
import { type InstalledPackage, SetupConfigError, verifyInstalled } from "../setup/index.ts";
import type { AllowedRoots } from "../../pi-review/extension/index.ts";

export type { InstalledPackage };

/** The agent directory and its listed packages, as the CLI read them from `settings.json`. */
export interface StepPackages {
  /** Absolute. */
  agentDir: string;
  /** `packages` from settings.json. */
  packages: readonly unknown[];
}

export interface ResolvedModules {
  /** For the run record (A-6): name, source as configured, version or commit. */
  packages: InstalledPackage[];
  /** Extension entry points, canonical, in the order pi would load them. */
  extensions: Array<{ path: string; source: string }>;
}

/** Thrown for anything the operator has to fix; the step turns it into a `config` error. */
export class ModulesConfigError extends Error {
  override name = "ModulesConfigError";
}

const RESOURCE_KINDS = ["extensions", "skills", "prompts", "themes"] as const;

export async function resolveModules(input: StepPackages, roots: AllowedRoots, cwd: string): Promise<ResolvedModules> {
  let packages: InstalledPackage[];
  try {
    // Also refuses AGENTS.md, SYSTEM.md and links into a root in the agent directory (C-3a).
    packages = verifyInstalled({ agentDir: input.agentDir, packages: input.packages, forbiddenRoots: roots.roots });
  } catch (e) {
    if (e instanceof SetupConfigError) throw new ModulesConfigError(e.message);
    throw e;
  }
  if (packages.length === 0) return { packages, extensions: [] };

  // The listed packages as user-scope settings of an untrusted project whose
  // directory is the step's empty cwd. Every package is installed (checked
  // above), so pi neither installs nor asks npm where its global root is.
  const manager = new DefaultPackageManager({
    cwd,
    agentDir: input.agentDir,
    settingsManager: SettingsManager.inMemory({ packages: input.packages as PackageSource[] }, { projectTrusted: false }),
  });
  const resolved = await manager.resolve(() => Promise.resolve("error" as const));
  if (resolved.installFailures !== undefined && resolved.installFailures.length > 0) {
    throw new ModulesConfigError(`packages could not be resolved: ${resolved.installFailures.map((f) => `${f.source}: ${f.message}`).join("; ")}`);
  }

  const extensions: ResolvedModules["extensions"] = [];
  for (const kind of RESOURCE_KINDS) {
    for (const resource of resolved[kind]) {
      // Auto-discovered and top-level entries, and pi's built-ins, are not listed packages.
      if (resource.metadata.origin !== "package" || !resource.enabled) continue;
      let real: string;
      try {
        real = realpathSync(resource.path);
      } catch {
        throw new ModulesConfigError(`package ${JSON.stringify(resource.metadata.source)}: its ${kind} entry ${resource.path} does not exist`);
      }
      if (roots.contains(real)) {
        throw new ModulesConfigError(
          `package ${JSON.stringify(resource.metadata.source)}: its ${kind} entry ${resource.path} resolves to ${real}, inside a read root (F-7, C-3a)`,
        );
      }
      if (kind === "extensions") extensions.push({ path: real, source: resource.metadata.source });
    }
  }
  return { packages, extensions };
}
