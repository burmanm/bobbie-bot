/**
 * Fetching the operator's agent directory for the action (F-7, C-2, C-3,
 * D-19): from the consumer's **default branch**, or from an organization
 * configuration repository pinned to a commit. Never from the PR, neither
 * its head nor its base: `models.json` can run a command and pi packages
 * execute code.
 *
 * Through the GitHub API, so no job checks anything out. Only regular files
 * are taken; a symlink or submodule in the directory is an error, so nothing
 * can point outside it. Bounded in files and bytes.
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Github } from "./github.ts";

export const AGENT_DIR_MAX_FILES = 200;
export const AGENT_DIR_MAX_BYTES = 8 * 1024 * 1024;

/** A relative directory path in the repository: no `.`/`..` segments, no leading or doubled `/`. */
const SEGMENT = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;

export function validAgentDirPath(path: string): boolean {
  return path.length <= 400 && path.split("/").every((s) => SEGMENT.test(s));
}

export interface FetchedAgentDir {
  repo: string;
  /** The commit the files are from. */
  sha: string;
  /** The default branch, when no commit was pinned. */
  branch?: string;
  files: number;
  bytes: number;
}

/**
 * Copy `path` at `ref` (a pinned commit), or at the default branch's head
 * when `ref` is undefined, into the empty or absent directory `dest`.
 */
export async function fetchAgentDir(gh: Github, o: { path: string; ref?: string; dest: string }): Promise<FetchedAgentDir> {
  if (!validAgentDirPath(o.path)) throw new Error(`invalid agent directory path: ${JSON.stringify(o.path)} (a relative path in the repository)`);
  if (o.ref !== undefined && !/^[0-9a-f]{40}$/.test(o.ref)) throw new Error("the agent directory's repository must be pinned to a 40-hex commit SHA");
  let sha = o.ref;
  let branch: string | undefined;
  if (sha === undefined) ({ branch, sha } = await gh.getDefaultBranchHead());

  const prefix = `${o.path}/`;
  const entries = (await gh.getTree(sha)).filter((e) => e.path.startsWith(prefix));
  const where = `${gh.repo}@${sha.slice(0, 12)}:${o.path}`;
  if (entries.length === 0) throw new Error(`${where}: no such directory, or it is empty`);
  const files = entries.filter((e) => e.type === "blob" && (e.mode === "100644" || e.mode === "100755"));
  const other = entries.filter((e) => e.type !== "tree" && !files.includes(e));
  if (other.length > 0) throw new Error(`${where}: only regular files are allowed, not ${other.map((e) => `${e.path} (${e.mode})`).slice(0, 5).join(", ")}`);
  if (files.length > AGENT_DIR_MAX_FILES) throw new Error(`${where}: more than ${AGENT_DIR_MAX_FILES} files`);
  const declared = files.reduce((n, e) => n + (e.size ?? 0), 0);
  if (declared > AGENT_DIR_MAX_BYTES) throw new Error(`${where}: more than ${AGENT_DIR_MAX_BYTES} bytes`);

  mkdirSync(o.dest, { recursive: true });
  if (readdirSync(o.dest).length > 0) throw new Error(`${o.dest} is not empty`);
  let bytes = 0;
  for (const e of files) {
    const rel = e.path.slice(prefix.length);
    // Tree paths come from git, but are checked as strictly as the input.
    if (!rel.split("/").every((s) => SEGMENT.test(s))) throw new Error(`${where}: unexpected path ${JSON.stringify(e.path)}`);
    const data = await gh.getBlob(e.sha);
    bytes += data.length;
    if (bytes > AGENT_DIR_MAX_BYTES) throw new Error(`${where}: more than ${AGENT_DIR_MAX_BYTES} bytes`);
    const target = join(o.dest, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data, { mode: 0o444, flag: "wx" });
  }
  return { repo: gh.repo, sha, ...(branch === undefined ? {} : { branch }), files: files.length, bytes };
}
