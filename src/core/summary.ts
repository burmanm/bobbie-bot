/**
 * Summary body (S-7, I-2 #11), assembled by code from typed parts, in this
 * order:
 *
 *   1. Round and commit range covered (optional).
 *   2. Count line: "N important, M nits, K pre-existing." or a plain
 *      "Nothing to fix" statement.
 *   3. Needs human lines, in a warning block right under the count, so
 *      they are seen first (I-2 #5).
 *   4. Earlier findings: still open / verified fixed.
 *   5. Pre-existing items, each with a proposed tech-debt issue or a link.
 *   6. Questions for the author.
 *   7. Checked, nothing found.
 *   8. CI note (C-9), not run / partial-run note, extra tools from the
 *      operator's packages (F-7).
 *   9. How to resolve: [wrong] / [intentional] / [not-worth-it], last.
 *
 * The hidden summary marker (last reviewed SHA) follows on its own line; it
 * does not render, so the visible body still ends with the resolve line.
 *
 * All free text (from the model or the PR) is passed through markdown.ts,
 * so it cannot forge the bot's state or become live Markdown (C-3, H-51).
 */
import { isLive } from "./grounding.ts";
import { codeSpan, safeLine, safeText, sameRepoIssueUrl } from "./markdown.ts";
import { encodeMarker, type SummaryMarker } from "./marker.ts";
import type { Finding, Location, NeedsHumanNote, Question } from "./schemas.ts";

export interface SummaryCounts {
  important: number;
  nits: number;
  preExisting: number;
}

export interface EarlierFinding {
  title: string;
  /** What was checked (fixed) or the remaining case (still open). */
  detail?: string;
  tag?: "important" | "nit";
}

export interface PreExistingItem {
  title: string;
  location?: Location;
  /** Proposed one-line tech-debt issue title, or the URL of an existing issue (A-3 proposedIssue). */
  proposedIssue?: string;
}

export interface SummaryParts {
  /** owner/name of the reviewed repository: only its issue URLs stay live (H-51). */
  repo?: string;
  round?: { number: number; headSha: string; sinceSha?: string };
  counts: SummaryCounts;
  earlier?: { stillOpen: EarlierFinding[]; verifiedFixed: EarlierFinding[] };
  preExisting?: PreExistingItem[];
  questions?: Question[];
  checked?: string[];
  notRun?: string[];
  /** Set when the run was partial (S-9); says what is missing. */
  partial?: string;
  /** C-9: the review ran although CI failed or could not be read. */
  ci?: string;
  needsHuman?: NeedsHumanNote[];
  /**
   * Tools from the operator's packages that were active (F-7, H-60): the
   * maintainers chose them, readers should know the review had them.
   */
  extraTools?: ExtraTool[];
  marker: SummaryMarker;
}

/** A tool a package provided in the review (F-7). */
export interface ExtraTool {
  tool: string;
  /** The package's source as configured. */
  source: string;
  /** It replaced the bot's own tool of that name. */
  replaces: boolean;
}

/** Counts over the findings that will be published (live statuses). */
export function summaryCounts(findings: readonly Finding[]): SummaryCounts {
  const live = findings.filter(isLive);
  return {
    important: live.filter((f) => f.tag === "important").length,
    nits: live.filter((f) => f.tag === "nit").length,
    preExisting: live.filter((f) => f.tag === "pre-existing").length,
  };
}

/** Pre-existing items for the summary from live findings (I-2 #4). */
export function preExistingItems(findings: readonly Finding[]): PreExistingItem[] {
  return findings
    .filter((f) => isLive(f) && f.tag === "pre-existing")
    .map((f) => {
      const item: PreExistingItem = { title: f.title };
      if (f.locations[0]) item.location = f.locations[0];
      if (f.proposedIssue !== undefined) item.proposedIssue = f.proposedIssue;
      return item;
    });
}

export function formatLocation(l: Location): string {
  return l.endLine > l.startLine ? `${l.path}:${l.startLine}-${l.endLine}` : `${l.path}:${l.startLine}`;
}

/** Untrusted text inside a list item, continuation lines indented. */
function item(s: string): string {
  return safeText(s, { indent: 2, inline: true });
}

/** Untrusted text after a bold label. */
function labelled(s: string): string {
  return safeText(s, { inline: true });
}

const short = (sha: string) => sha.slice(0, 7);

export function countLine(c: SummaryCounts, stillOpen = 0): string {
  const open = stillOpen > 0 ? ` ${stillOpen} earlier ${stillOpen === 1 ? "finding is" : "findings are"} still open.` : "";
  const counts = `${c.important} important, ${c.nits} ${c.nits === 1 ? "nit" : "nits"}, ${c.preExisting} pre-existing.`;
  if (c.important + c.nits + c.preExisting === 0 && stillOpen === 0) return `**Nothing to fix: ${counts}**`;
  return `**${counts}${open}**`;
}

export function needsHumanLine(n: NeedsHumanNote): string {
  const where = safeLine(n.locations.map(formatLocation).join(", "));
  return `Needs human: ${safeLine(n.what)} in ${where}. Explained in the description: ${n.explainedInDescription ? "yes" : "no"}.`;
}

/**
 * The needs-human lines as a GitHub warning alert (I-2 #5). The alert syntax
 * is written here, by code; each note is one safeLine, after a bold label,
 * so untrusted text cannot end the block or open another.
 */
export function needsHumanBlock(notes: readonly NeedsHumanNote[]): string {
  const lines = notes.map((n) => `> **Needs human:** ${needsHumanLine(n).slice("Needs human: ".length)}`);
  return ["> [!WARNING]", lines.join("\n>\n")].join("\n");
}

function preExistingLine(p: PreExistingItem, repo: string | undefined): string {
  const where = p.location ? ` (${codeSpan(formatLocation(p.location))})` : "";
  let issue: string;
  if (p.proposedIssue === undefined) issue = "No `tech-debt` issue proposed.";
  else if (/^https?:\/\/\S+$/.test(p.proposedIssue.trim())) {
    issue = `Existing issue: ${sameRepoIssueUrl(p.proposedIssue, repo) ?? safeLine(p.proposedIssue)}`;
  } else {
    const title = safeLine(p.proposedIssue);
    // A star in the title would end the italics.
    issue = `Proposed \`tech-debt\` issue: ${title.includes("*") ? title : `*${title}*`}`;
  }
  return `- ${safeLine(p.title)}${where}. ${issue}`;
}

export const RESOLVE_LINE =
  "**Resolving:** reply with `[wrong]`, `[intentional]` or `[not-worth-it]` when you resolve a finding without a code change.";

export function renderSummary(p: SummaryParts): string {
  const blocks: string[] = [];

  if (p.round) {
    const range = p.round.sinceSha
      ? `the changes since \`${short(p.round.sinceSha)}\` up to \`${short(p.round.headSha)}\``
      : `\`${short(p.round.headSha)}\``;
    blocks.push(`Automated review, round ${p.round.number}. It covers ${range}.`);
  }

  const stillOpen = p.earlier?.stillOpen ?? [];
  const fixed = p.earlier?.verifiedFixed ?? [];
  blocks.push(countLine(p.counts, stillOpen.length));

  if (p.needsHuman?.length) blocks.push(needsHumanBlock(p.needsHuman));

  if (stillOpen.length + fixed.length > 0) {
    const line = (label: string, e: EarlierFinding) => {
      const tag = e.tag ? ` (${e.tag === "important" ? "Important" : "Nit"})` : "";
      return `- **${label}${tag}:** ${safeLine(e.title)}${e.detail ? ` — ${item(e.detail)}` : ""}`;
    };
    blocks.push(
      ["**Earlier findings:**", ...stillOpen.map((e) => line("Still open", e)), ...fixed.map((e) => line("Verified fixed", e))].join("\n"),
    );
  }

  if (p.preExisting?.length) {
    blocks.push(["**Pre-existing:**", ...p.preExisting.map((x) => preExistingLine(x, p.repo))].join("\n"));
  }

  if (p.questions?.length) {
    blocks.push(
      [
        "**Questions for the author:**",
        ...p.questions.map((q) => {
          const where = q.locations.length ? ` (${q.locations.map((l) => codeSpan(formatLocation(l))).join(", ")})` : "";
          return `- ${item(q.body)}${where}`;
        }),
      ].join("\n"),
    );
  }

  if (p.checked?.length) {
    blocks.push(["**Checked, nothing found:**", ...p.checked.map((c) => `- ${item(c)}`)].join("\n"));
  }

  const notRun: string[] = [];
  if (p.ci !== undefined) notRun.push(`**CI:** ${labelled(p.ci)}`);
  if (p.partial !== undefined) notRun.push(`**Partial review:** ${labelled(p.partial)}`);
  if (p.notRun?.length) notRun.push(["**Not run:**", ...p.notRun.map((n) => `- ${item(n)}`)].join("\n"));
  if (p.extraTools?.length) {
    notRun.push(
      [
        "**Extra tools from packages:**",
        ...p.extraTools.map((t) => `- ${codeSpan(t.tool)} from ${codeSpan(t.source)}${t.replaces ? ", replacing the bot's own" : ""}`),
      ].join("\n"),
    );
  }
  if (notRun.length) blocks.push(notRun.join("\n\n"));

  blocks.push(RESOLVE_LINE);

  return blocks.join("\n\n") + "\n\n" + encodeMarker(p.marker) + "\n";
}
