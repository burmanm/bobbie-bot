/**
 * Fingerprint (A-4): a stable identity for "the same issue" across pushes,
 * line shifts and runs. sha256 over (version, path, category, normalized
 * anchor), where the anchor is the flagged code with whitespace collapsed.
 * Line numbers are deliberately not part of it.
 */
import { createHash } from "node:crypto";
import type { Category, ProducerFinding, Root } from "./schemas.ts";

/** Bump whenever the recipe below changes; recorded in every record and marker. */
export const FINGERPRINT_VERSION = 1;

/** Collapse all whitespace runs (including CR/LF) to one space and trim. */
export function normalizeAnchor(code: string): string {
  return code.replace(/\s+/g, " ").trim();
}

export function fingerprint(path: string, category: Category, anchorCode: string): string {
  const input = JSON.stringify([FINGERPRINT_VERSION, path, category, normalizeAnchor(anchorCode)]);
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Reads a file from a snapshot root; undefined when absent. Supplied by the caller, so core does no I/O. */
export type FileLookup = (root: Root, path: string) => string | undefined;

/** Lines start..end (1-based, inclusive) of a text, without line terminators. undefined when out of range. */
export function sliceLines(text: string, start: number, end: number): string[] | undefined {
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (text.endsWith("\n")) lines.pop();
  if (start < 1 || end < start || end > lines.length) return undefined;
  return lines.slice(start - 1, end);
}

/**
 * The anchor code of a finding: the head lines of its first location. When
 * those cannot be read (path missing, lines out of range), the finding's
 * title stands in, so the fingerprint is still deterministic.
 */
export function anchorCode(f: Pick<ProducerFinding, "locations" | "title">, lookup: FileLookup): string {
  const anchor = f.locations[0];
  if (anchor) {
    const text = lookup("head", anchor.path);
    const lines = text === undefined ? undefined : sliceLines(text, anchor.startLine, anchor.endLine);
    if (lines !== undefined && normalizeAnchor(lines.join("\n")) !== "") return lines.join("\n");
  }
  return `title:${f.title}`;
}

export function fingerprintFinding(f: Pick<ProducerFinding, "locations" | "title" | "category">, lookup: FileLookup): string {
  const path = f.locations[0]?.path ?? "";
  return fingerprint(path, f.category, anchorCode(f, lookup));
}
