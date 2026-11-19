/**
 * Knowledge (A-5, D-6, D-7): the repository's `AGENTS.md`, `REVIEW.md` and
 * vendored `.review/*-guidelines.md`, plus bot settings in
 * `.review/review-bot.yaml` — all read from the **base** tree, never the
 * head. Per-area `REVIEW.md` files (A-5) are loaded once the changed paths
 * are known: a `REVIEW.md` in any directory above a changed file applies to
 * it, in addition to the root one (core/review-areas.ts says how they
 * combine).
 *
 * For the pilot, the knowledge files can come from another directory
 * (`--knowledge-dir`, `--guidelines`) while the repository has none of its
 * own; the run record says so.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { candidateAreaDirs } from "../core/index.ts";

export interface KnowledgeFile {
  /** Display path: repository-relative for the base tree, otherwise the file name. */
  path: string;
  source: "base" | "override";
  /** Absolute path for an override, else undefined. */
  origin?: string;
  text: string;
  sha256: string;
}

export interface Knowledge {
  agents?: KnowledgeFile;
  review?: KnowledgeFile;
  guidelines: KnowledgeFile[];
  /** `.review/review-bot.yaml` text, when present. */
  botConfig?: KnowledgeFile;
  /** Per-area `REVIEW.md` files, path order (A-5). Filled by `loadAreaReviews`. */
  areas: KnowledgeFile[];
  /** The tree the root `REVIEW.md` came from; area files come from the same one. */
  tree?: { root: string; source: KnowledgeFile["source"] };
}

export interface KnowledgeOverride {
  /** Directory holding AGENTS.md, REVIEW.md and optionally .review/. */
  dir?: string;
  /** Extra guideline files. */
  guidelines?: string[];
}

const MAX_KNOWLEDGE_BYTES = 512 * 1024;

/** Read `rel` inside `root`, refusing anything that resolves outside it. */
export function readInside(root: string, rel: string): string | undefined {
  const realRoot = realpathSync(root);
  const target = resolve(realRoot, rel);
  if (!existsSync(target)) return undefined;
  const real = realpathSync(target);
  const r = relative(realRoot, real);
  if (r === "" || r.startsWith("..") || isAbsolute(r)) return undefined;
  const st = statSync(real);
  if (!st.isFile() || st.size > MAX_KNOWLEDGE_BYTES) return undefined;
  return readFileSync(real, "utf8");
}

function file(path: string, source: KnowledgeFile["source"], text: string, origin?: string): KnowledgeFile {
  const f: KnowledgeFile = { path, source, text, sha256: createHash("sha256").update(text, "utf8").digest("hex") };
  if (origin !== undefined) f.origin = origin;
  return f;
}

function guidelineNames(root: string): string[] {
  const dir = join(root, ".review");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /^[A-Za-z0-9._-]+-guidelines\.md$/.test(n))
    .sort()
    .map((n) => `.review/${n}`);
}

function fromTree(root: string, source: KnowledgeFile["source"]): Knowledge {
  const k: Knowledge = { guidelines: [], areas: [], tree: { root, source } };
  const read = (rel: string) => readInside(root, rel);
  const origin = (rel: string) => (source === "override" ? resolve(root, rel) : undefined);
  const agents = read("AGENTS.md");
  if (agents !== undefined) k.agents = file("AGENTS.md", source, agents, origin("AGENTS.md"));
  const review = read("REVIEW.md");
  if (review !== undefined) k.review = file("REVIEW.md", source, review, origin("REVIEW.md"));
  for (const rel of guidelineNames(root)) {
    const text = read(rel);
    if (text !== undefined) k.guidelines.push(file(rel, source, text, origin(rel)));
  }
  const yaml = read(".review/review-bot.yaml");
  if (yaml !== undefined) k.botConfig = file(".review/review-bot.yaml", source, yaml, origin(".review/review-bot.yaml"));
  return k;
}

export function loadKnowledge(baseTree: string, override: KnowledgeOverride = {}): Knowledge {
  const base = fromTree(baseTree, "base");
  if (override.dir === undefined && (override.guidelines ?? []).length === 0) return base;

  const k: Knowledge = override.dir === undefined ? base : fromTree(override.dir, "override");
  // Bot settings stay the base branch's unless the override directory has its own.
  if (k.botConfig === undefined && base.botConfig !== undefined) k.botConfig = base.botConfig;
  for (const g of override.guidelines ?? []) {
    const abs = resolve(g);
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_KNOWLEDGE_BYTES) throw new Error(`guidelines file ${g} is not a readable file`);
    k.guidelines.push(file(abs.split("/").pop()!, "override", readFileSync(abs, "utf8"), abs));
  }
  return k;
}

/** At most this many area files are loaded; more is a sign of a misconfigured repository. */
export const MAX_AREA_FILES = 50;

/**
 * Load the area `REVIEW.md` files that apply to `paths` (A-5): one in any
 * directory above a changed file, from the same tree as the root file.
 * Sets and returns `k.areas`.
 */
export function loadAreaReviews(k: Knowledge, paths: readonly string[]): KnowledgeFile[] {
  k.areas = [];
  if (k.tree === undefined || k.review === undefined) return k.areas;
  const { root, source } = k.tree;
  for (const dir of candidateAreaDirs(paths)) {
    if (k.areas.length >= MAX_AREA_FILES) break;
    const rel = `${dir}/REVIEW.md`;
    const text = readInside(root, rel);
    if (text !== undefined) k.areas.push(file(rel, source, text, source === "override" ? resolve(root, rel) : undefined));
  }
  return k.areas;
}

/** The files the run loaded, for the run record (A-6). */
export function knowledgeFileList(k: Knowledge): string[] {
  const all = [k.agents, k.review, ...k.areas, ...k.guidelines, k.botConfig].filter((f): f is KnowledgeFile => f !== undefined);
  return all.map((f) => (f.source === "base" ? `base:${f.path}` : `override:${f.origin}#sha256=${f.sha256.slice(0, 12)}`));
}

/** Knowledge paths a PR edit would have changed; a PR cannot reconfigure the bot (C-3). */
export function isKnowledgePath(path: string): boolean {
  return path === "AGENTS.md" || path === "REVIEW.md" || path.endsWith("/REVIEW.md") || /^\.review\/[^/]+$/.test(path);
}
