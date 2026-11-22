/**
 * Source snapshots for a local dry-run (S-1, C-3, C-3a). In the R-2 workflow
 * the unprivileged `prepare` job produces them; locally they are extracted
 * here. Either way they are plain trees with no `.git`, read as data only.
 *
 * Nothing here runs code from the snapshot: extraction is `git archive`,
 * a tarball download through `gh`, or a directory copy.
 */
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

export type SnapshotSide = "head" | "base";

export interface SnapshotSource {
  readonly kind: string;
  /** Extract the tree of `sha` into the empty directory `dest`. */
  extract(side: SnapshotSide, sha: string, dest: string): Promise<void>;
}

/**
 * Names that make pi or another agent harness pick up context or a
 * repository from a parent directory (C-3a: "Where the snapshot is
 * extracted").
 */
export const CONTEXT_NAMES = [".git", "AGENTS.md", "AGENTS.override.md", "CLAUDE.md"] as const;

/**
 * Throws when `dir` or any parent contains a `.git` entry or a context file.
 * The snapshot itself is checked separately; its own files are data.
 */
export function assertIsolatedLocation(dir: string): void {
  let current = resolve(dir);
  const root = parse(current).root;
  for (;;) {
    for (const name of CONTEXT_NAMES) {
      if (existsSync(join(current, name))) {
        throw new Error(
          `snapshot location ${dir} is not isolated: ${join(current, name)} exists (C-3a). Use --runs-dir to pick a directory with no .git or context files above it.`,
        );
      }
    }
    if (current === root) return;
    current = dirname(current);
  }
}

export type Exec = (
  file: string,
  args: readonly string[],
  options?: { cwd?: string; binary?: boolean; input?: Buffer },
) => Promise<{ stdout: Buffer }>;

/** `execFile` without a shell; stdout as a Buffer. */
export const defaultExec: Exec = (file, args, options = {}) =>
  new Promise((resolvePromise, reject) => {
    const child = execFile(
      file,
      [...args],
      { cwd: options.cwd, encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = Buffer.isBuffer(stderr) ? stderr.toString("utf8").trim() : "";
          reject(new Error(`${file} ${args.join(" ")} failed: ${detail || error.message}`));
        } else {
          resolvePromise({ stdout });
        }
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });

function assertEmptyDir(dest: string): void {
  mkdirSync(dest, { recursive: true });
  if (readdirSync(dest).length > 0) throw new Error(`snapshot destination ${dest} is not empty`);
}

/** Extract a tar archive given as bytes. Absolute and `..` member paths are refused by tar itself. */
async function untar(exec: Exec, archive: Buffer, dest: string, gzip: boolean, stripComponents: number): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "review-bot-tar-"));
  try {
    const file = join(work, gzip ? "tree.tar.gz" : "tree.tar");
    writeFileSync(file, archive);
    const args = [gzip ? "-xzf" : "-xf", file, "-C", dest];
    if (stripComponents > 0) args.push(`--strip-components=${stripComponents}`);
    await exec("tar", args);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Copies `<dir>/head` and `<dir>/base` (test fixtures). */
export class DirectorySnapshots implements SnapshotSource {
  readonly kind = "directory";
  private readonly dirs: { head: string; base: string };
  constructor(dirs: { head: string; base: string }) {
    this.dirs = dirs;
  }

  async extract(side: SnapshotSide, _sha: string, dest: string): Promise<void> {
    assertEmptyDir(dest);
    cpSync(this.dirs[side], dest, { recursive: true, verbatimSymlinks: true });
  }
}

/** `git archive <sha>` from a local clone that already has the commit. Never fetches. */
export class GitArchiveSnapshots implements SnapshotSource {
  readonly kind = "git-archive";
  private readonly repoDir: string;
  private readonly exec: Exec;
  constructor(repoDir: string, exec: Exec = defaultExec) {
    this.repoDir = repoDir;
    this.exec = exec;
  }

  /**
   * The repository named with `--git-dir`, never `-C`: once
   * `safe.bareRepository=explicit` is set (C-3a), git refuses to discover a
   * bare clone from its directory, so `-C <bare clone>` fails.
   */
  private gitDir(): string {
    const dotGit = join(this.repoDir, ".git");
    return existsSync(dotGit) ? dotGit : this.repoDir;
  }

  async extract(side: SnapshotSide, sha: string, dest: string): Promise<void> {
    assertEmptyDir(dest);
    const gitDir = this.gitDir();
    try {
      await this.exec("git", ["--git-dir", gitDir, "cat-file", "-e", `${sha}^{commit}`]);
    } catch {
      throw new Error(
        `${side} commit ${sha} is not in ${this.repoDir}; fetch it first (for a PR head: git fetch origin pull/<N>/head)`,
      );
    }
    const { stdout } = await this.exec("git", ["--git-dir", gitDir, "archive", "--format=tar", sha], { binary: true });
    await untar(this.exec, stdout, dest, false, 0);
  }
}

/** The tarball GitHub serves for a commit, downloaded read-only through `gh api`. */
export class GhTarballSnapshots implements SnapshotSource {
  readonly kind = "gh-tarball";
  private readonly repo: string;
  private readonly exec: Exec;
  constructor(repo: string, exec: Exec = defaultExec) {
    this.repo = repo;
    this.exec = exec;
  }

  async extract(_side: SnapshotSide, sha: string, dest: string): Promise<void> {
    assertEmptyDir(dest);
    const { stdout } = await this.exec("gh", ["api", `repos/${this.repo}/tarball/${sha}`], { binary: true });
    // GitHub wraps the tree in one top-level "<owner>-<repo>-<sha>/" directory.
    await untar(this.exec, stdout, dest, true, 1);
  }
}

/**
 * The Go module cache when present (S-4: read-only library source at the
 * pinned version). Never runs `go`: GOMODCACHE, then GOPATH's first entry,
 * then ~/go. Whether it holds the PR's versions is not checked here.
 */
export function defaultModcache(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates: string[] = [];
  if (env.GOMODCACHE) candidates.push(env.GOMODCACHE);
  if (env.GOPATH) candidates.push(join(env.GOPATH.split(":")[0]!, "pkg", "mod"));
  if (env.HOME) candidates.push(join(env.HOME, "go", "pkg", "mod"));
  return candidates.find((c) => existsSync(c));
}
