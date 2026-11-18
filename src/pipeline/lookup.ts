/**
 * The `FileLookup` that core's grounding and fingerprinting use (S-5, A-4):
 * reads a file from one snapshot root, never outside it. Paths come from the
 * model, so they are resolved with symlinks followed and checked against the
 * root, like the agent's guard does.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { FileLookup, Root } from "../core/index.ts";

const MAX_FILE_BYTES = 8 * 1024 * 1024;

export function snapshotLookup(roots: Partial<Record<Root, string>>): FileLookup {
  const real: Partial<Record<Root, string>> = {};
  for (const [k, v] of Object.entries(roots) as Array<[Root, string | undefined]>) {
    if (v !== undefined && existsSync(v)) real[k] = realpathSync(v);
  }
  const cache = new Map<string, string | undefined>();
  return (root, path) => {
    const dir = real[root];
    if (dir === undefined) return undefined;
    const key = `${root}\0${path}`;
    if (cache.has(key)) return cache.get(key);
    let text: string | undefined;
    try {
      // An absolute path is accepted only when it is inside the root.
      const target = isAbsolute(path) ? path : resolve(dir, path);
      if (existsSync(target)) {
        const file = realpathSync(target);
        const rel = relative(dir, file);
        if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
          const st = statSync(file);
          if (st.isFile() && st.size <= MAX_FILE_BYTES) text = readFileSync(file, "utf8");
        }
      }
    } catch {
      text = undefined;
    }
    cache.set(key, text);
    return text;
  };
}
