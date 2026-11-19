/**
 * Summary body (S-7, I-2 #11), assembled by code from typed parts, in this
 * order:
 *
 *   1. Round and commit range covered (optional).
 *   2. Count line: "N important, M nits, K pre-existing." or a plain
 *      "Nothing to fix" statement.
 *   3. Earlier findings: still open / verified fixed.
 *   4. Pre-existing items, each with a proposed tech-debt issue or a link.
 *   5. Questions for the author.
 *   6. Checked, nothing found.
 *   7. CI note (C-9), not run / partial-run note.
 *   8. How to resolve: [wrong] / [intentional] / [not-worth-it].
 *   9. Needs human lines.
 *
 * The hidden summary marker (last reviewed SHA) follows on its own line; it
 * does not render, so the visible body still ends with the Needs-human line.
 *
 * All free text (from the model or the PR) is passed through
 * neutralizeMarkers, so it cannot forge the bot's state.
 */
import { isLive } from "./grounding.ts";
import { encodeMarker, neutralizeMarkers, type SummaryMarker } from "./marker.ts";
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
  marker: SummaryMarker;
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

/** Untrusted text as one markdown list item body: markers neutralized, continuation lines indented. */
function text(s: string): string {
  return neutralizeMarkers(s.trim()).replace(/\r\n?/g, "\n").replace(/\n/g, "\n  ");
}

/** Untrusted text on a single line. */
function oneLine(s: string): string {
  return neutralizeMarkers(s).replace(/\s+/g, " ").trim();
}

function code(s: string): string {
  const clean = oneLine(s);
  const ticks = clean.includes("`") ? "``" : "`";
  const pad = clean.startsWith("`") || clean.endsWith("`") ? " " : "";
  return `${ticks}${pad}${clean}${pad}${ticks}`;
}

const short = (sha: string) => sha.slice(0, 7);

export function countLine(c: SummaryCounts, stillOpen = 0): string {
  const open = stillOpen > 0 ? ` ${stillOpen} earlier ${stillOpen === 1 ? "finding is" : "findings are"} still open.` : "";
  const counts = `${c.important} important, ${c.nits} ${c.nits === 1 ? "nit" : "nits"}, ${c.preExisting} pre-existing.`;
  if (c.important + c.nits + c.preExisting === 0 && stillOpen === 0) return `**Nothing to fix: ${counts}**`;
  return `**${counts}${open}**`;
}

export function needsHumanLine(n: NeedsHumanNote): string {
  const where = n.locations.map(formatLocation).join(", ");
  return `Needs human: ${oneLine(n.what)} in ${where}. Explained in the description: ${n.explainedInDescription ? "yes" : "no"}.`;
}

function preExistingLine(p: PreExistingItem): string {
  const where = p.location ? ` (${code(formatLocation(p.location))})` : "";
  let issue: string;
  if (p.proposedIssue === undefined) issue = "No `tech-debt` issue proposed.";
  else if (/^https?:\/\/\S+$/.test(p.proposedIssue.trim())) issue = `Existing issue: ${oneLine(p.proposedIssue)}`;
  else issue = `Proposed \`tech-debt\` issue: *${oneLine(p.proposedIssue).replace(/\*/g, "\\*")}*`;
  return `- ${text(p.title)}${where}. ${issue}`;
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

  if (stillOpen.length + fixed.length > 0) {
    const item = (label: string, e: EarlierFinding) => {
      const tag = e.tag ? ` (${e.tag === "important" ? "Important" : "Nit"})` : "";
      return `- **${label}${tag}:** ${text(e.title)}${e.detail ? ` — ${text(e.detail)}` : ""}`;
    };
    blocks.push(
      ["**Earlier findings:**", ...stillOpen.map((e) => item("Still open", e)), ...fixed.map((e) => item("Verified fixed", e))].join("\n"),
    );
  }

  if (p.preExisting?.length) {
    blocks.push(["**Pre-existing:**", ...p.preExisting.map(preExistingLine)].join("\n"));
  }

  if (p.questions?.length) {
    blocks.push(
      [
        "**Questions for the author:**",
        ...p.questions.map((q) => {
          const where = q.locations.length ? ` (${q.locations.map((l) => code(formatLocation(l))).join(", ")})` : "";
          return `- ${text(q.body)}${where}`;
        }),
      ].join("\n"),
    );
  }

  if (p.checked?.length) {
    blocks.push(["**Checked, nothing found:**", ...p.checked.map((c) => `- ${text(c)}`)].join("\n"));
  }

  const notRun: string[] = [];
  if (p.ci !== undefined) notRun.push(`**CI:** ${text(p.ci)}`);
  if (p.partial !== undefined) notRun.push(`**Partial review:** ${text(p.partial)}`);
  if (p.notRun?.length) notRun.push(["**Not run:**", ...p.notRun.map((n) => `- ${text(n)}`)].join("\n"));
  if (notRun.length) blocks.push(notRun.join("\n\n"));

  blocks.push(RESOLVE_LINE);

  if (p.needsHuman?.length) blocks.push(p.needsHuman.map(needsHumanLine).join("\n"));

  return blocks.join("\n\n") + "\n\n" + encodeMarker(p.marker) + "\n";
}
