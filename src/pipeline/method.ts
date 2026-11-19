/**
 * The bot's own instructions (A-5 "What the bot does ship"): the review
 * method skill and the verifier / re-check prompts, loaded from the pi
 * package. Their combined hash goes into the run record (A-6).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PI_REVIEW_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "pi-review");

export interface Method {
  reviewer: string;
  verifier: string;
  recheck: string;
  /** sha256 over the three files, in that order. */
  hash: string;
}

/** Drop a leading YAML front matter block. */
export function stripFrontMatter(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  return (m ? text.slice(m[0].length) : text).trim() + "\n";
}

export function loadMethod(dir: string = PI_REVIEW_DIR): Method {
  const files = [
    join(dir, "skills", "review-method", "SKILL.md"),
    join(dir, "prompts", "verify-finding.md"),
    join(dir, "prompts", "recheck-finding.md"),
  ];
  const texts = files.map((f) => readFileSync(f, "utf8"));
  const hash = createHash("sha256");
  for (const t of texts) hash.update(t, "utf8").update("\0");
  return {
    reviewer: stripFrontMatter(texts[0]!),
    verifier: stripFrontMatter(texts[1]!),
    recheck: stripFrontMatter(texts[2]!),
    hash: hash.digest("hex"),
  };
}
