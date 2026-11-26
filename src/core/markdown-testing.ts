/**
 * What is live in a Markdown body, for the H-51 tests. Deliberately separate
 * from markdown.ts: it knows only CommonMark's fence, code-span and `<pre>`
 * rules, so a construct the sanitizer mistakes for code shows up here as live
 * text. Not imported by production code.
 */
import assert from "node:assert/strict";
import { decodeMarkers } from "./marker.ts";

/** The text a renderer may act on: everything outside code and the bot's own markers. */
export function liveText(md: string): string {
  const out: string[] = [];
  let fence: string | undefined;
  let pre = false;
  for (const line of md.split(/\r\n?|\n/)) {
    if (pre) {
      if (line.includes("</pre>")) pre = false;
      continue;
    }
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== undefined) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && f[2]!.trim() === "") fence = undefined;
      continue;
    }
    if (f && !(f[1]![0] === "`" && f[2]!.includes("`"))) {
      fence = f[1]!;
      out.push("");
      continue;
    }
    if (/^ {0,3}<pre><code>/.test(line)) {
      pre = !line.includes("</pre>");
      continue;
    }
    if (decodeMarkers(line).length === 1 || /^<!-- review-bot:failure bot=[\w./-]+ -->$/.test(line)) continue;
    // The needs-human alert's first line, written by summary.ts (I-2 #5). Sanitized text never yields it: a "[" outside code becomes &#91;.
    if (line === "> [!WARNING]") continue;
    out.push(line.replace(/(?<![`\\])(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g, " \u0001 "));
  }
  assert.equal(fence, undefined, "a fence is left open");
  assert.equal(pre, false, "a <pre> is left open");
  return out.join("\n");
}

/** Nothing outside code can become an image, link, HTML, mention, table, math or cross-repository reference. */
export function assertInert(md: string): void {
  const live = liveText(md);
  const context = `\nlive text:\n${live}\nbody:\n${md}`;
  for (const [what, re] of [
    ["link, image or reference bracket", /\[/],
    ["HTML or autolink", /</],
    ["URL", /:\/\//],
    ["www autolink", /www\./i],
    ["mention or e-mail", /@/],
    ["math", /\$/],
    ["cross-repository reference", /[\w.-]#\d/],
    ["unmatched backtick", /`/],
    ["fence", /~~~/],
    ["backslash escape", /\\/],
    ["table delimiter row or setext rule", /^(?![ \t]*- *$)(?=[^\n]*-)[ \t]*(?:>[ \t]*)*[|:-][ \t|:-]*$/m],
  ] as const) {
    assert.doesNotMatch(live, re, `${what} is live${context}`);
  }
}

/** No raw line starts with something another bot takes as a command (they do not parse Markdown). */
export function assertNoCommandLines(md: string): void {
  for (const line of md.split(/\r\n?|\n/)) {
    assert.doesNotMatch(
      line,
      /^[\s>*_]*(?:\/(?:approve|lgtm|merge|ok-to-test|label|hold|retest)\b|!merge\b|\.deploy\b|@(?:dependabot|mergifyio|claude)\b|bors r|retest\b|recheck\b|lgtm\b|ok to test\b|azp run\b)/i,
      `command line in:\n${md}`,
    );
  }
}
