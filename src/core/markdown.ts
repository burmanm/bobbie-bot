/**
 * Untrusted text as safe GitHub Markdown (C-3, S-7, H-51): the one place
 * where text from the model or the PR becomes Markdown the bot posts.
 *
 * An escaper that has to agree with GitHub about what is code can be bypassed
 * wherever the two disagree. So nothing is passed through: the input is read
 * for code, and everything is written again so that only the constructs
 * written here can be structure.
 *
 * - Code spans and fenced code keep their content. They are re-delimited
 *   with a backtick run the content cannot close, spans on one line, fences
 *   always closed.
 * - Everywhere else `[`, `<`, backticks, backslashes, entities and tilde
 *   fences are written as entities, and delimiter rows are broken. So there
 *   is no link, image, reference, HTML, footnote or table, and no stray
 *   delimiter that could pair with one of ours.
 * - What GitHub makes live from plain text becomes a code span: URLs, `www.`,
 *   mentions and e-mail, `other/repo#1`, math. Mentions and commands also get
 *   a zero-width space, because other bots read the raw text.
 * - A code block with a command or one of this bot's markers is written as
 *   `<pre>` with entities: it displays the same and has no such raw line.
 * - The only link left live is an issue of the reviewed repository in a
 *   finding's `proposedIssue` (sameRepoIssueUrl). GitHub still links a plain
 *   `#1` or commit SHA, and those can only point into this repository.
 *
 * Applying safeLine to its own output gives the same text: titles are read
 * back from posted comments (S-6).
 */

const ZWSP = "\u200b";
/** Separates what must not merge; it renders as nothing. */
const GAP = "&#8203;";

/**
 * Fence languages that are only highlighted. An allowlist: GitHub renders
 * some (mermaid, math, geojson, stl) and applies `suggestion`.
 */
const LANGUAGES = new Set(
  `bash c c# c++ cc clojure cpp cs csharp css dart diff dockerfile elixir erlang go golang gomod graphql groovy h haskell hcl hpp
  html ini java javascript js json json5 jsonc jsx kotlin kt lua make makefile nix objc patch perl php plaintext powershell proto
  protobuf py python r rb rs ruby rust scala sh shell sql swift terraform text toml ts tsx txt typescript xml yaml yml zig zsh`.split(/\s+/),
);

/** At the start of a line of prose: phrases other bots act on. */
const WORD_COMMAND =
  /^([\s>*_~#+-]*)((?:re-?test this please|re-?test|re-?check|lgtm|ok to test|test this please|add to whitelist|bors[ \t]+(?:try|merge|retry|delegate)|azp[ \t]+run|buildkite[ \t]+build|jenkins,?[ \t]+(?:test|retest|rebuild))(?!\w)|bors[ \t]+(?:r[+=-]|d\+)|homu[ \t]+r\+|(?:approved?|merge|re-?run|re-?build|ship ?it|\+1)(?=[\s*_~.!]*$))/i;
/** At the start of a line of prose: `/cmd`, `!cmd`, `.cmd`. */
const SIGIL_COMMAND = /^([\s>*_~#+-]*)([!/.][A-Za-z][\w-]*)/;
/** In code, where false positives cost a one-click suggestion, so narrower. */
const CODE_COMMAND =
  /^[\s>*_]*(?:\/[A-Za-z][\w-]*(?![\w/-]|[.:]\w)|<!--\s*review-bot:|!(?:merge|deploy|retest|approve|rebase)\b|\.(?:deploy|noop|lock|unlock)(?=\s*$| to )|bors[ \t]+(?:r[+=-]|try)|azp[ \t]+run\b|(?:re-?test|re-?check|lgtm|ok to test|test this please|retest this please)(?=[\s.!,:;)-]*$|[ \t]+[A-Za-z]))/i;
/** Bots that act on a mention anywhere in the raw text. */
const CODE_MENTION =
  /@(?:dependabot|renovate|renovatebot|mergifyio|claude|copilot|coderabbitai|codex|gemini-code-assist|cursor|bugbot|bors|rustbot|pytorchbot|k8s-ci-robot|openshift-ci-robot)(?![\w/-])/i;

/**
 * Line ends as one character, NUL as the U+FFFD CommonMark makes of it: a
 * parser that dropped a NUL would merge the delimiters on either side.
 */
function normalized(s: string): string {
  return s.replace(/\r\n?/g, "\n").split("\u0000").join("�");
}

/** Untrusted text as one line, whitespace around line breaks collapsed. */
function joinLines(s: string): string {
  return normalized(s)
    .split(/[\r\n\u0085\u2028\u2029]/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .join(" ");
}

// ---- code ------------------------------------------------------------------

function span(content: string, before: string): string {
  const runs = new Set(content.match(/`+/g)?.map((r) => r.length));
  let n = 1;
  while (runs.has(n)) n++;
  const ticks = "`".repeat(n);
  // A space is stripped from each side when both have one and not all is space.
  const pad = /^`|`$/.test(content) || (content.startsWith(" ") && content.endsWith(" ") && /[^ ]/.test(content)) ? " " : "";
  // Adjacent runs would merge; three at the start of a line would open a fence.
  const gap = before.endsWith("`") || n >= 3 ? GAP : "";
  return `${gap}${ticks}${pad}${content}${pad}${ticks}`;
}

/** Untrusted text (a path, a location) as one code span. */
export function codeSpan(s: string): string {
  return span(joinLines(s) || " ", "");
}

function readByBots(lines: readonly string[]): boolean {
  return lines.some((l) => CODE_MENTION.test(l) || l.split(/[\u0085\u2028\u2029]/).some((p) => CODE_COMMAND.test(p)));
}

function fenced(lines: readonly string[], info: string): string {
  let longest = 2;
  for (const line of lines) for (const run of line.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const ticks = "`".repeat(longest + 1);
  return [`${ticks}${info}`, ...lines, ticks].join("\n");
}

function entity(c: string): string {
  return `&#${c.codePointAt(0)};`;
}

/** Code as `<pre>`: displayed exactly, no raw line starts with what it displays. */
function preformatted(lines: readonly string[]): string {
  const encode = (s: string) => s.replace(/[&<>@/!`~[\]$\\\u0085\u2028\u2029]/g, entity);
  const body = lines.map((line) => {
    const m = /^([ \t]*)([^ \t])/u.exec(line);
    return m ? `${m[1]}${entity(m[2]!)}${encode(line.slice(m[0].length))}` : line;
  });
  return `<pre><code>${body.join("\n")}</code></pre>`;
}

// ---- prose -----------------------------------------------------------------

/** Text as it would display: the entities written here decoded, invisible controls dropped. */
function displayed(s: string): string {
  return s
    .replace(/&(amp|lt|#45|#91|#92|#96|#126|#58|#124|#8203);/g, (_, e: string) =>
      e === "amp" ? "&" : e === "lt" ? "<" : String.fromCodePoint(Number(e.slice(1))),
    )
    .replace(/[\v\f\u0085\u2028\u2029]/g, " ")
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u00ad\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "");
}

function escapeText(s: string): string {
  return s
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, "&amp;")
    .replace(/\\/g, "&#92;")
    .replace(/</g, "&lt;")
    .replace(/\[/g, "&#91;")
    .replace(/`/g, "&#96;")
    .replace(/~{3,}/g, (run) => "&#126;".repeat(run.length));
}

/** What GitHub or another bot could act on inside one word of prose. */
function isLive(word: string): boolean {
  // `www` before any punctuation: the caller may put a full stop after it, which makes a link.
  return /:\/\/|www(?![A-Za-z0-9])|[@$]|[\w.-]#\d/i.test(word) || /^[*_~('"]*\/[A-Za-z][\w-]*(?:[*~().,;:!?'"][*_~().,;:!?'"]*)?$/.test(word);
}

/** One live word as a code span, leaving surrounding emphasis and punctuation outside. */
function inertWord(word: string, before: string): string {
  let start = 0;
  let end = word.length;
  while (start < end && "*_~('".includes(word[start]!)) start++;
  while (end > start && "*_~().,;:!?'".includes(word[end - 1]!)) end--;
  let core = word.slice(start, end).replace(/@/g, `@${ZWSP}`);
  if (/^\/[A-Za-z][\w-]*$/.test(core)) core = `/${ZWSP}${core.slice(1)}`;
  const lead = escapeText(word.slice(0, start));
  return lead + span(core, lead || before) + escapeText(word.slice(end));
}

/** A run of prose within one line; `before` is what that line already holds. */
function prose(raw: string, before: string): string {
  let rest = displayed(raw);
  let out = "";
  if (before.trim() === "" || before === GAP) {
    const command = WORD_COMMAND.exec(rest) ?? SIGIL_COMMAND.exec(rest);
    if (command) {
      let text = command[2]!;
      rest = rest.slice(command[0].length);
      if (SIGIL_COMMAND.test(text)) {
        // The whole word, so that a path or URL is not split in two.
        const tail = /^[^\s[\]<>"`]*/.exec(rest)![0];
        rest = rest.slice(tail.length);
        text += tail.replace(/@/g, `@${ZWSP}`);
      }
      out = escapeText(command[1]!);
      out += span(`${text[0]}${ZWSP}${text.slice(1)}`, out || before);
    }
  }
  let from = 0;
  for (const m of rest.matchAll(/[^\s[\]<>"]+/g)) {
    out += escapeText(rest.slice(from, m.index));
    out += isLive(m[0]) ? inertWord(m[0], out || before) : escapeText(m[0]);
    from = m.index + m[0].length;
  }
  return out + escapeText(rest.slice(from));
}

/** Where a code span cannot continue: blank lines, quotes, headings, list items. */
const BLOCK_START = /^(?:[ \t]*$|[ \t]*(?:>|#{1,6}[ \t]|[-+*][ \t]|\d{1,9}[.)][ \t]))/;

/** One paragraph: its code spans kept, the rest made inert. */
function paragraph(source: string): string {
  const runs = [...source.matchAll(/`+/g)].map((m) => ({ at: m.index, length: m[0].length }));
  const byLength = new Map<number, { at: number[]; next: number }>();
  for (const r of runs) {
    const same = byLength.get(r.length);
    if (same) same.at.push(r.at);
    else byLength.set(r.length, { at: [r.at], next: 0 });
  }

  const done: string[] = [];
  let line = "";
  const addProse = (s: string) => {
    for (const [i, part] of s.split("\n").entries()) {
      if (i > 0) {
        done.push(line);
        line = "";
      }
      line += prose(part, line);
    }
  };

  let from = 0;
  for (const run of runs) {
    if (run.at < from) continue;
    let slashes = 0;
    while (run.at - slashes > from && source[run.at - slashes - 1] === "\\") slashes++;
    // An escaped backtick is text; the rest of its run can still open a span.
    const open = run.at + (slashes % 2);
    const length = run.at + run.length - open;
    const same = byLength.get(length);
    if (same === undefined) continue;
    while (same.next < same.at.length && same.at[same.next]! < open + length) same.next++;
    const close = same.at[same.next];
    if (close === undefined) continue;
    addProse(source.slice(from, open));
    let content = source
      .slice(open + length, close)
      .split("\n")
      .map((l, i) => (i === 0 ? l : l.replace(/^[ \t]+/, "")))
      .join(" ");
    if (content.startsWith(" ") && content.endsWith(" ") && /[^ ]/.test(content)) content = content.slice(1, -1);
    line += span(content, line);
    from = close + length;
  }
  addProse(source.slice(from));
  done.push(line);

  return done.map(breakDelimiterRow).join("\n");
}

/**
 * A delimiter row makes a table, whose pipes split code spans. The caller's
 * list marker can supply the dash, so a lone pipe or colon counts as one.
 */
function breakDelimiterRow(line: string): string {
  return /^[ \t>*+\-|:\d.)]*$/.test(line) ? line.replace(/[-|:]/, entity) : line;
}

function proseBlock(lines: readonly string[]): string {
  const paragraphs: string[][] = [];
  for (const line of lines) {
    const last = paragraphs.at(-1);
    if (last === undefined || BLOCK_START.test(line)) paragraphs.push([line]);
    else last.push(line);
  }
  return paragraphs.map((p) => paragraph(p.join("\n"))).join("\n");
}

// ---- blocks ----------------------------------------------------------------

/** Deeper quotes are read as prose: stripping them is quadratic. */
const MAX_QUOTE_DEPTH = 16;

interface Block {
  code: boolean;
  info: string;
  lines: string[];
}

function unquote(line: string, depth: number): string | undefined {
  let s = line;
  for (let i = 0; i < depth; i++) {
    const m = /^[ \t]*> ?/.exec(s);
    if (!m) return undefined;
    s = s.slice(m[0].length);
  }
  return s;
}

/**
 * Fenced code, also in a quote or list item, and the prose between. A wrong
 * guess costs formatting only: both kinds are written out safely.
 */
function readBlocks(source: string): Block[] {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  let text: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const depth = Math.min(MAX_QUOTE_DEPTH, /^(?:[ \t]*>)*/.exec(line)![0].split(">").length - 1);
    const open = /^([ \t]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?)(`{3,}|~{3,})(.*)$/.exec(unquote(line, depth) ?? "");
    if (!open || (open[2]![0] === "`" && open[3]!.includes("`"))) {
      text.push(line);
      continue;
    }
    if (text.length > 0) blocks.push({ code: false, info: "", lines: text });
    text = [];
    const width = open[1]!.length;
    const fence = open[2]!;
    const language = /^\S*/.exec(open[3]!.trim())![0].toLowerCase();
    const code: string[] = [];
    while (i + 1 < lines.length) {
      const inner = unquote(lines[i + 1]!, depth);
      if (inner === undefined) break; // the quote ended, and the fence with it
      i++;
      const close = /^([ \t]*)(`{3,}|~{3,})[ \t]*$/.exec(inner);
      if (close && close[1]!.length <= width + 3 && close[2]![0] === fence[0] && close[2]!.length >= fence.length) break;
      let cut = 0;
      while (cut < width && (inner[cut] === " " || inner[cut] === "\t")) cut++;
      code.push(inner.slice(cut));
    }
    blocks.push({ code: true, info: LANGUAGES.has(language) ? language : "", lines: code });
  }
  if (text.length > 0) blocks.push({ code: false, info: "", lines: text });
  return blocks;
}

export interface SafeTextOptions {
  /** Columns to indent continuation lines by (2 inside a list item). */
  indent?: number;
  /** The text shares its first and last line with the caller's: code then gets lines of its own. */
  inline?: boolean;
}

/** Untrusted multi-line text as Markdown that is safe to post. */
export function safeText(s: string, o: SafeTextOptions = {}): string {
  const source = normalized(s).trim();
  if (source === "") return "";
  const blocks = readBlocks(source);
  const parts = blocks.map((b) => (!b.code ? proseBlock(b.lines) : readByBots(b.lines) ? preformatted(b.lines) : fenced(b.lines, b.info)));
  if (o.inline) {
    if (blocks[0]!.code) parts.unshift(GAP);
    // An empty first line would turn the caller's list marker into a heading rule.
    else if (parts[0]!.split("\n")[0]!.trim() === "") parts[0] = GAP + parts[0];
    if (blocks.at(-1)!.code) parts.push(GAP);
  }
  const pad = " ".repeat(o.indent ?? 0);
  return parts
    .join("\n")
    .split("\n")
    .map((l, i) => (i === 0 || l === "" ? l : pad + l))
    .join("\n");
}

/** Untrusted text as one line of Markdown that is safe to post. */
export function safeLine(s: string): string {
  // Trimming can leave only a delimiter row.
  return breakDelimiterRow(paragraph(joinLines(s)).trim());
}

/** The typed suggestion (S-7): exact, and applicable unless another bot would act on one of its lines. */
export function safeSuggestion(s: string): string {
  const lines = normalized(s).replace(/\n$/, "").split("\n");
  if (!readByBots(lines)) return fenced(lines, "suggestion");
  return `_Suggested replacement, not offered as a one-click change because a line in it reads as a bot command or marker:_\n\n${preformatted(lines)}`;
}

/** Characters of check-run summary kept. Escaping expands text and GitHub allows 65535. */
const CHECK_SUMMARY_MAX = 4_000;

/**
 * A check-run or job summary. Cut before it is escaped: cutting afterwards
 * could remove a closing delimiter and make the rest live.
 */
export function safeSummary(s: string): string {
  return safeText(s.length <= CHECK_SUMMARY_MAX ? s : `${s.slice(0, CHECK_SUMMARY_MAX)}…`);
}

/**
 * The URL of an issue of `repo` when that is all `s` is (I-2 #4), printed
 * from the trusted repository name. No query, fragment or other path: those
 * could carry data out or embed other content.
 */
export function sameRepoIssueUrl(s: string, repo: string | undefined): string | undefined {
  if (repo === undefined) return undefined;
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/issues\/([1-9][0-9]{0,9})$/.exec(s.trim());
  if (!m || m[1]!.toLowerCase() !== repo.toLowerCase()) return undefined;
  return `https://github.com/${repo}/issues/${m[2]}`;
}
