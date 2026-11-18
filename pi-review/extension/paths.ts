/**
 * Path confinement for the read tools (C-3 "cannot read outside the
 * snapshots"). pi does not confine read/grep/find/ls: they accept absolute
 * paths, `..` and `~` (spike-r0-findings §5). Everything here works on
 * canonical paths, so a symlink inside a root that points out of it is
 * outside.
 */
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The characters pi's own resolver turns into a plain space (utils/paths.js). */
const UNICODE_SPACES = /[  -   　]/g;

export type PathCheck =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/** True when `target` is `root` or lies under it. Both must be canonical. */
export function isWithin(root: string, target: string): boolean {
  if (target === root) return true;
  return target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Canonical form of `p` (absolute): realpath of the nearest existing ancestor
 * plus the part that does not exist yet. A path that does not exist cannot
 * be followed through a symlink, so this is safe to compare.
 */
export function canonicalize(p: string): string {
  let current = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return p;
      tail.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      current = parent;
    }
  }
}

/**
 * The read roots of one step: head (the session's cwd), base and module
 * cache. Each is canonicalized once; a root that does not exist is a
 * configuration error and throws.
 */
export class AllowedRoots {
  readonly roots: readonly string[];

  constructor(roots: readonly string[]) {
    if (roots.length === 0) throw new Error("at least one read root is required");
    this.roots = roots.map((r) => {
      if (!isAbsolute(r)) throw new Error(`read root must be absolute: ${r}`);
      try {
        return realpathSync(r);
      } catch {
        throw new Error(`read root does not exist: ${r}`);
      }
    });
  }

  contains(canonical: string): boolean {
    return this.roots.some((root) => isWithin(root, canonical));
  }

  /**
   * Check a path argument the way pi's tools will interpret it
   * (`resolveToCwd`: unicode spaces, `@` prefix, `~`, `file://`), relative to
   * `cwd`. Used by the `tool_call` guard, so the model gets a clear reason.
   */
  check(raw: unknown, cwd: string): PathCheck {
    if (typeof raw !== "string") return { ok: false, reason: "path must be a string" };
    let p = raw.replace(UNICODE_SPACES, " ");
    if (p.startsWith("@")) p = p.slice(1);
    // pi expands "~" to the runner's home directory, which is never a root.
    if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
      return { ok: false, reason: outside(raw) };
    }
    if (p.startsWith("file://")) {
      try {
        p = fileURLToPath(p);
      } catch {
        return { ok: false, reason: `Path "${raw}" is not a valid file URL.` };
      }
    }
    const target = canonicalize(isAbsolute(p) ? resolve(p) : resolve(cwd, p));
    if (!this.contains(target)) return { ok: false, reason: outside(raw) };
    return { ok: true, path: target };
  }

  /**
   * Second barrier, at the point of file access: `absolutePath` is exactly
   * what a tool is about to open. It must exist and resolve inside a root.
   * Catches anything the argument check could miss, such as pi's read tool
   * retrying a missing path under a look-alike name (NFD, curly quote).
   */
  resolveForAccess(absolutePath: string): string {
    let real: string;
    try {
      real = realpathSync(absolutePath);
    } catch {
      throw new Error(`Path not found: ${absolutePath}`);
    }
    if (!this.contains(real)) throw new Error(outside(absolutePath));
    return real;
  }
}

export function outside(raw: string): string {
  return `Path "${raw}" is outside the allowed read roots.`;
}
