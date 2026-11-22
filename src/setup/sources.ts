/**
 * The `packages` entries of the operator's `settings.json` (F-7, "Adding a
 * pi package"). The version is the pin, so a range, tag or branch is refused.
 * Accepts less than pi does, and never something pi would read differently.
 */
import { type AgentDir, assertOutsideRoots, inspectAgentDir } from "./agent-dir.ts";
import { SetupConfigError } from "./errors.ts";
import { followLinks, isRecord, overlaps } from "./files.ts";
import { createPiLayout, type PiLayout } from "./pi-layout.ts";

export interface PackagesInput {
  /** The operator's pi agent directory. */
  agentDir: string;
  /** `packages` as parsed from `settings.json`. */
  packages: unknown;
  /** Every read root: head, base, module cache, inputs. They need not exist yet. */
  forbiddenRoots: readonly string[];
}

interface Common {
  /** The source as configured. */
  source: string;
  /** Where pi loads it from. */
  path: string;
}

export type Package =
  | (Common & { type: "npm"; name: string; version: string })
  | (Common & { type: "git"; name: string; repo: string; commit: string })
  | (Common & { type: "local" });

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
/** semver without `v`, `=` or build metadata, which the registry drops. */
const EXACT_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*)?$/;
/** https, or pi's `git:host/path` shorthand for it. No credentials, query or fragment. */
const GIT_PINNED =
  /^(?:git:(?:https:\/\/)?|https:\/\/)[A-Za-z0-9][A-Za-z0-9.-]*(?::\d+)?(?:\/(?!\.\.?(?:\/|@))[A-Za-z0-9._~-]+){2,}@([0-9a-f]{40}|[0-9a-f]{64})$/;
const FILTERS = ["extensions", "skills", "prompts", "themes"];

/** A source for an error message: a token written into a URL is not repeated. */
function shown(source: string): string {
  return JSON.stringify(source.replace(/^(git:)[^/@]*:[^/]*@/i, "$1***@").replace(/\/\/[^/]*@/g, "//***@"));
}

function readEntry(entry: unknown, where: string): string {
  let source: unknown = entry;
  if (isRecord(entry)) {
    for (const [key, value] of Object.entries(entry)) {
      if (key === "source") continue;
      const valid =
        key === "autoload"
          ? typeof value === "boolean"
          : FILTERS.includes(key) && Array.isArray(value) && value.every((v) => typeof v === "string");
      if (!valid) throw new SetupConfigError(`${where}: "${key}" is not a valid package option`);
    }
    source = entry.source;
  }
  if (typeof source !== "string" || source === "") {
    throw new SetupConfigError(`${where} must be a source string or an object with a "source" string`);
  }
  // pi trims some forms and rewrites some spaces, so refuse rather than guess.
  if (source !== source.trim() || /[\u0000-\u001f\u007f]/.test(source)) {
    throw new SetupConfigError(`${where}: the source has surrounding whitespace or control characters`);
  }
  return source;
}

function parsePackage(source: string, where: string, layout: PiLayout): Package {
  const bad = (reason: string) => new SetupConfigError(`${where} ${shown(source)}: ${reason}`);

  if (source.startsWith("npm:")) {
    const spec = source.slice(4);
    const at = spec.lastIndexOf("@");
    const name = at > 0 ? spec.slice(0, at) : spec;
    const version = at > 0 ? spec.slice(at + 1) : "";
    if (!EXACT_VERSION.test(version)) {
      throw bad("an npm source needs an exact version, like npm:@scope/name@1.2.3; ranges and tags are refused (F-7)");
    }
    if (name.length > 214 || name === "node_modules" || !NPM_NAME.test(name)) throw bad("not an npm package name");
    const parsed = layout.parse(source);
    if (parsed.type !== "npm" || parsed.name !== name || parsed.version !== version) throw bad("pi reads this source differently");
    return { type: "npm", source, name, version, path: layout.installPath(parsed) };
  }

  if (/^(?:git:|https:|http:|ssh:|git@)/i.test(source)) {
    if (/^(?:git:)?(?:http:|ssh:|git:\/\/|git@)/i.test(source)) {
      throw bad("a git source must use https: setup has no keys to authenticate with, and fetches nothing in clear text (C-4)");
    }
    const commit = GIT_PINNED.exec(source)?.[1];
    if (commit === undefined) {
      throw bad("a git source needs https, no credentials and a full commit SHA, like git:github.com/org/repo@<sha>; branches and tags are refused (F-7)");
    }
    const parsed = layout.parse(source);
    if (parsed.type !== "git" || parsed.ref !== commit || !parsed.repo.startsWith("https://")) {
      throw bad("pi reads this source differently");
    }
    return { type: "git", source, name: `${parsed.host}/${parsed.path}`, repo: parsed.repo, commit, path: layout.installPath(parsed) };
  }

  // pi takes anything else as a path, unknown schemes included.
  if (/^[^/]*:/.test(source)) throw bad("unsupported source; use npm:, git: or a path");
  if (source.startsWith("~")) throw bad("a path must not depend on the runner's home directory (C-3a)");
  const parsed = layout.parse(source);
  if (parsed.type !== "local") throw bad("pi reads this source differently");
  return { type: "local", source, path: layout.installPath(parsed) };
}

export function inspectPackages(input: PackagesInput): { dir: AgentDir; packages: Package[] } {
  const dir = inspectAgentDir(input.agentDir, input.forbiddenRoots);
  const entries = input.packages ?? [];
  if (input.packages === null || !Array.isArray(entries)) throw new SetupConfigError("packages must be an array");

  const layout = createPiLayout(dir.path);
  const packages: Package[] = [];
  const places: { type: Package["type"]; path: string; where: string }[] = [];
  for (const [i, entry] of entries.entries()) {
    const where = `packages[${i}]`;
    const pkg = parsePackage(readEntry(entry, where), where, layout);
    assertOutsideRoots(dir, pkg.path, where);

    // pi keeps the first of two entries for one package without saying so,
    // and installing one git repository inside another would replace it.
    const path = followLinks(pkg.path);
    const clash = places.find(
      (p) =>
        p.path.toLowerCase() === path.toLowerCase() ||
        (p.type === "git" && pkg.type === "git" && overlaps(p.path, path)),
    );
    if (clash !== undefined) throw new SetupConfigError(`${where} and ${clash.where} are the same package or install over each other`);
    places.push({ type: pkg.type, path, where });
    packages.push(pkg);
  }
  return { dir, packages };
}

/** Checks the entries and the agent directory. Installs and runs nothing. */
export function validatePackages(input: PackagesInput): Package[] {
  return inspectPackages(input).packages;
}
