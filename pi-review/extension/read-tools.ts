/**
 * pi's `read` and `ls`, with file access confined to the allowed roots.
 *
 * The `tool_call` guard (guard.ts) already rejects out-of-root path
 * arguments. These operations are the second barrier: they check the exact
 * path pi is about to open, after pi's own path handling (C-3, C-3a).
 */
import { createReadStream } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import {
  createLsToolDefinition,
  createReadToolDefinition,
  detectSupportedImageMimeTypeFromFile,
  type LsOperations,
  type ReadOperations,
} from "@earendil-works/pi-coding-agent";
import type { AllowedRoots } from "./paths.ts";

export function confinedReadOperations(roots: AllowedRoots): ReadOperations {
  return {
    readFile: async (p) => readFile(roots.resolveForAccess(p)),
    access: async (p) => access(roots.resolveForAccess(p), constants.R_OK),
    detectImageMimeType: async (p) => detectSupportedImageMimeTypeFromFile(roots.resolveForAccess(p)),
    createReadStream: (p, { signal }) =>
      createReadStream(roots.resolveForAccess(p), signal === undefined ? {} : { signal }),
  };
}

export function confinedLsOperations(roots: AllowedRoots): LsOperations {
  return {
    exists: (p) => {
      try {
        roots.resolveForAccess(p);
        return true;
      } catch {
        return false;
      }
    },
    // ls stats every entry to mark directories. An entry that resolves
    // outside the roots (an escaping symlink) is still listed by name, but
    // nothing about its target is revealed.
    stat: async (p) => {
      let real: string;
      try {
        real = roots.resolveForAccess(p);
      } catch {
        return { isDirectory: () => false };
      }
      return stat(real);
    },
    readdir: async (p) => readdir(roots.resolveForAccess(p)),
  };
}

export function createConfinedReadTool(cwd: string, roots: AllowedRoots) {
  return createReadToolDefinition(cwd, { operations: confinedReadOperations(roots) });
}

export function createConfinedLsTool(cwd: string, roots: AllowedRoots) {
  return createLsToolDefinition(cwd, { operations: confinedLsOperations(roots) });
}
