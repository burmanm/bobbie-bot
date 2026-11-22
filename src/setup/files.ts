/** Paths as the kernel resolves them (C-3a), and manifest reading. */
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SetupConfigError } from "./errors.ts";

const MAX_LINKS = 40;

/**
 * Where `path` leads through every symlink, also when the end does not exist
 * yet: setup checks destinations before they are installed, and roots before
 * the snapshot is extracted. A dangling link into a root still leads into it.
 */
export function followLinks(path: string, linksLeft = MAX_LINKS): string {
  try {
    return realpathSync.native(path);
  } catch {
    // Missing or dangling: resolve one component at a time below.
  }
  const parent = dirname(path);
  if (parent === path) return path;
  const name = basename(path);
  const realParent = followLinks(parent, linksLeft);
  // Not normalised before this point: `..` applies to where the link led.
  if (name === "." || name === "..") return resolve(realParent, name);
  const entry = join(realParent, name);
  let target: string;
  try {
    if (!lstatSync(entry).isSymbolicLink()) return entry;
    target = readlinkSync(entry);
  } catch {
    return entry;
  }
  if (linksLeft === 0) throw new SetupConfigError(`too many symbolic links: ${path}`);
  return followLinks(isAbsolute(target) ? target : `${realParent}${sep}${target}`, linksLeft - 1);
}

export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Whether one of the paths contains the other. Case is ignored: the check
 * fails closed on case-insensitive file systems, where a path that does not
 * exist yet has no canonical spelling.
 */
export function overlaps(a: string, b: string): boolean {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return isWithin(x, y) || isWithin(y, x);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON object file; undefined when there is none. */
export function readJsonObject(path: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new SetupConfigError(`cannot read ${path}: ${code ?? String(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new SetupConfigError(`${path} is not valid JSON`);
  }
  if (!isRecord(value)) throw new SetupConfigError(`${path} must hold a JSON object`);
  return value;
}
