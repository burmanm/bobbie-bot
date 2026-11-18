/**
 * `REVIEW.md` sections the bot parses mechanically (A-5): "Skip these paths"
 * and "Limits" (nit cap). Everything else goes to the reviewer verbatim.
 * Headings are the contract with the review-process template; a missing
 * heading means no skip paths / no cap.
 *
 * A heading matches case-insensitively at any level, ignoring trailing "#"s
 * and punctuation. A section runs until the next heading of the same or a
 * higher level. Headings inside fenced code blocks are ignored.
 */

export interface SkipEntry {
  glob: string;
  /** Prose after the glob ("unless the PR's purpose is test data"). Such entries are not hard-filtered (S-2). */
  qualifier: string | undefined;
  /** The list item as written, for the run record. */
  source: string;
}

export interface ReviewMd {
  skipEntries: SkipEntry[];
  /** Maximum nits per review; undefined when no cap is stated. */
  nitCap: number | undefined;
  /** Which of the parsed headings were present. */
  found: { skipPaths: boolean; limits: boolean };
  /** List items under "Skip these paths" that hold no glob, kept for the record. */
  unparsedSkipItems: string[];
}

interface Section {
  title: string;
  level: number;
  body: string[];
}

function normalizeHeading(s: string): string {
  return s
    .replace(/\s+#+\s*$/, "")
    .replace(/[*_`:.]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Split markdown into heading sections. Text before the first heading is dropped. */
function sections(text: string): Section[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Section[] = [];
  let fence: string | undefined;
  let current: Section | undefined;
  for (const line of lines) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      const marker = f[1]!;
      if (fence === undefined) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      current?.body.push(line);
      continue;
    }
    const h = fence === undefined ? /^ {0,3}(#{1,6})\s+(.*)$/.exec(line) : null;
    if (h) {
      current = { title: normalizeHeading(h[2]!), level: h[1]!.length, body: [] };
      out.push(current);
    } else {
      current?.body.push(line);
    }
  }
  return out;
}

/** Body of the first section with this title, including nested subsections. */
function sectionBody(all: Section[], title: string): string[] | undefined {
  const idx = all.findIndex((s) => s.title === title);
  if (idx < 0) return undefined;
  const top = all[idx]!;
  const body = [...top.body];
  for (let j = idx + 1; j < all.length && all[j]!.level > top.level; j++) body.push(...all[j]!.body);
  return body;
}

function stripHtmlComments(lines: string[]): string[] {
  return lines.join("\n").replace(/<!--[\s\S]*?(?:-->|$)/g, "").split("\n");
}

/** Top-level list items of a section, continuation lines joined. */
function listItems(lines: string[]): string[] {
  const items: string[] = [];
  let cur: string | undefined;
  for (const line of lines) {
    const m = /^ {0,1}[-*+]\s+(.*)$/.exec(line) ?? /^ {0,1}\d+[.)]\s+(.*)$/.exec(line);
    if (m) {
      if (cur !== undefined) items.push(cur);
      cur = m[1]!.trim();
    } else if (cur !== undefined && /^\s+\S/.test(line)) {
      cur += " " + line.trim();
    } else if (line.trim() === "" || cur !== undefined) {
      if (cur !== undefined) items.push(cur);
      cur = undefined;
    }
  }
  if (cur !== undefined) items.push(cur);
  return items;
}

/** A bare (unquoted) token that looks like a path glob rather than a word of prose. */
function looksLikeGlob(token: string): boolean {
  return /^[\w.\-/*?[\]{}!]+$/.test(token) && /[/*.?]/.test(token);
}

/**
 * Parse one "Skip these paths" list item. Globs are the code spans in the
 * item; with no code span, a leading bare token that looks like a path.
 * Remaining prose (other than separators) is the qualifier.
 */
export function parseSkipItem(item: string): SkipEntry[] {
  const globs: string[] = [];
  let rest = item.replace(/`([^`]+)`/g, (_m, g: string) => {
    globs.push(g.trim());
    return " ";
  });
  if (globs.length === 0) {
    const first = /^(\S+)(.*)$/.exec(item.trim());
    if (first && looksLikeGlob(first[1]!.replace(/[,;]$/, ""))) {
      globs.push(first[1]!.replace(/[,;]$/, ""));
      rest = first[2]!;
    }
  }
  const leftover = rest
    .replace(/\b(and|or)\b/gi, " ")
    .replace(/[,;:.()\s]+/g, " ")
    .trim();
  const qualifier = leftover === "" ? undefined : rest.replace(/^[\s,;:]+/, "").trim();
  return globs.filter((g) => g !== "").map((glob) => ({ glob, qualifier, source: item }));
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, no: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/**
 * Nit cap from the Limits section: "At most 3 Nits per review." Accepts
 * "at most" / "no more than" / "max" / "maximum", digits or small number
 * words, and the template's "<3>" placeholder brackets.
 */
export function parseNitCap(lines: string[]): number | undefined {
  const text = lines.join("\n");
  const m = /\b(?:at most|no more than|max(?:imum)?(?: of)?)\s+<?(\d+|[a-z]+)>?\s+(?:\*\*|_)?nits?\b/i.exec(text);
  if (!m) return undefined;
  const raw = m[1]!.toLowerCase();
  const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
  return n === undefined || !Number.isSafeInteger(n) ? undefined : n;
}

export function parseReviewMd(text: string): ReviewMd {
  const all = sections(text);
  const skipBody = sectionBody(all, "skip these paths");
  const limitsBody = sectionBody(all, "limits");
  const skipEntries: SkipEntry[] = [];
  const unparsedSkipItems: string[] = [];
  if (skipBody) {
    for (const item of listItems(stripHtmlComments(skipBody))) {
      const entries = parseSkipItem(item);
      if (entries.length === 0) unparsedSkipItems.push(item);
      skipEntries.push(...entries);
    }
  }
  return {
    skipEntries,
    nitCap: limitsBody ? parseNitCap(stripHtmlComments(limitsBody)) : undefined,
    found: { skipPaths: skipBody !== undefined, limits: limitsBody !== undefined },
    unparsedSkipItems,
  };
}
