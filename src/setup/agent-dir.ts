/** The operator's agent directory before anything uses it (C-3a, F-7). */
import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { SetupConfigError } from "./errors.ts";
import { followLinks, overlaps } from "./files.ts";

/**
 * pi's context-file candidates (`loadContextFileFromDir`) and its two
 * system-prompt files. A test compares this with pi's source.
 */
export const REFUSED_FILES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
] as const;

const REFUSED = new Set(REFUSED_FILES.map((name) => name.toLowerCase()));

export interface AgentDir {
  /** Absolute, symlinks kept: pi resolves relative local sources against this. */
  path: string;
  real: string;
  forbidden: readonly { given: string; real: string }[];
}

export function inspectAgentDir(agentDir: string, forbiddenRoots: readonly string[]): AgentDir {
  if (!isAbsolute(agentDir)) throw new SetupConfigError(`the agent directory must be an absolute path: ${agentDir}`);
  const forbidden = forbiddenRoots.map((given) => {
    if (!isAbsolute(given)) throw new SetupConfigError(`a forbidden root must be an absolute path: ${given}`);
    return { given, real: followLinks(given) };
  });
  const path = resolve(agentDir);
  const dir: AgentDir = { path, real: followLinks(path), forbidden };
  assertOutsideRoots(dir, path, "the agent directory");

  let names: string[];
  try {
    if (!statSync(path).isDirectory()) throw new Error("not a directory");
    names = readdirSync(path);
  } catch {
    throw new SetupConfigError(`the agent directory is not a readable directory: ${path}`);
  }
  const refused = names.filter((name) => REFUSED.has(name.toLowerCase())).sort();
  if (refused.length > 0) {
    throw new SetupConfigError(
      `the agent directory must not contain ${refused.join(", ")}: pi would put it in the model's prompt (C-3a)`,
    );
  }
  // settings.json, models.json, package.json, .npmrc, npm/, git/ ...: a link
  // into a root would make a file from the PR configuration (D-19).
  for (const name of names) assertOutsideRoots(dir, join(path, name), `${name} in the agent directory`);
  return dir;
}

export function assertOutsideRoots(dir: AgentDir, path: string, what: string): void {
  const real = followLinks(path);
  const root = dir.forbidden.find((r) => overlaps(r.real, real));
  if (root !== undefined) {
    throw new SetupConfigError(`${what} resolves to ${real}, which overlaps the read root ${root.given} (F-7)`);
  }
}
