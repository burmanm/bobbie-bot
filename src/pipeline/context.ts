/**
 * S-3: `context.md`, shared by every reviewer step. PR text and existing
 * comments are untrusted and sit in delimited sections with delimiter
 * look-alikes neutralized (C-3: hygiene, not the defence). Knowledge files
 * from the base branch go in verbatim.
 */
import type { Exclusion, SoftSkip } from "../core/index.ts";
import type { PrComment, PullRequestInfo } from "../platform/index.ts";
import type { PatchFile } from "./deterministic.ts";
import type { Knowledge, KnowledgeFile } from "./knowledge.ts";
import type { PriorFinding } from "./prior.ts";

const UNTRUSTED = "untrusted-data";
const KNOWLEDGE = "knowledge-file";

/** Neutralize anything that could open or close one of our delimiters, and HTML comments. */
export function neutralizeDelimiters(text: string): string {
  return text
    .replace(/<(\/?)\s*(untrusted-data|knowledge-file)/gi, "&lt;$1$2")
    .replace(/<!--/g, "&lt;!--");
}

function untrusted(label: string, text: string): string {
  return `<${UNTRUSTED} source="${label}">\n${neutralizeDelimiters(text).trimEnd()}\n</${UNTRUSTED}>`;
}

function knowledgeBlock(f: KnowledgeFile): string {
  return `<${KNOWLEDGE} path="${f.path}">\n${f.text.replace(/<(\/?)\s*knowledge-file/gi, "&lt;$1knowledge-file").trimEnd()}\n</${KNOWLEDGE}>`;
}

export interface ContextInput {
  pr: PullRequestInfo;
  scope: "full" | "incremental";
  sinceSha?: string;
  patches: PatchFile[];
  excluded: Exclusion[];
  softSkips: SoftSkip[];
  knowledge: Knowledge;
  knowledgeSha: string;
  /** Knowledge files the PR edits; the base versions apply (C-3). */
  knowledgeEditedByPr: string[];
  comments: PrComment[];
  priorOpen: PriorFinding[];
  hasModcache: boolean;
}

const short = (sha: string) => sha.slice(0, 7);

export function buildContext(c: ContextInput): string {
  const out: string[] = [];
  out.push("# Review context", "");
  out.push(
    `Pull request ${c.pr.repo}#${c.pr.number}, base \`${short(c.pr.baseSha)}\`, head \`${short(c.pr.headSha)}\`.`,
    c.scope === "incremental" && c.sinceSha !== undefined
      ? `Scope: **incremental** — only the commits since \`${short(c.sinceSha)}\`, the last reviewed head. Earlier findings are listed at the end.`
      : "Scope: **full** — the whole pull request.",
    "",
  );

  out.push("## Pull request (untrusted)", "");
  out.push(
    untrusted(
      "pull-request",
      [
        `Title: ${c.pr.title}`,
        `Author: ${c.pr.author.login}`,
        `Labels: ${c.pr.labels.join(", ") || "(none)"}`,
        "",
        "Description:",
        c.pr.body.trim() === "" ? "(empty)" : c.pr.body,
      ].join("\n"),
    ),
    "",
  );

  out.push("## Change map", "");
  if (c.patches.length === 0) {
    out.push("No files to review.", "");
  } else {
    out.push("| File | Status | + | − | Patch (inputs root) |", "|---|---|---|---|---|");
    for (const p of c.patches) {
      const name = p.oldPath ? `\`${cell(p.oldPath)}\` → \`${cell(p.path)}\`` : `\`${cell(p.path)}\``;
      out.push(`| ${name} | ${p.status} | ${p.added} | ${p.removed} | \`${p.patchPath}\` |`);
    }
    out.push("");
  }
  if (c.excluded.length > 0) {
    out.push("Not reviewed (skipped mechanically):", "");
    for (const e of c.excluded) out.push(`- \`${cell(e.path)}\` — ${e.reason}`);
    out.push("");
  }
  if (c.softSkips.length > 0) {
    out.push("Matched by a qualified \"Skip these paths\" entry; apply the qualifier yourself:", "");
    for (const s of c.softSkips) out.push(`- \`${cell(s.path)}\` — \`${s.glob}\` ${s.qualifier}`);
    out.push("");
  }
  if (c.hasModcache) out.push("The dependency source cache is available as the `modcache` root.", "");
  else out.push("No dependency source cache is available in this run.", "");

  out.push(`## Repository knowledge (base \`${short(c.knowledgeSha)}\`)`, "");
  if (c.knowledgeEditedByPr.length > 0) {
    out.push(
      `This PR edits ${c.knowledgeEditedByPr.map((p) => `\`${p}\``).join(", ")}. The versions below are the base branch's and are the ones that apply; review the PR's edits to them like any other change.`,
      "",
    );
  }
  const files = [c.knowledge.agents, c.knowledge.review, ...c.knowledge.guidelines].filter((f): f is KnowledgeFile => f !== undefined);
  for (const f of files) out.push(knowledgeBlock(f), "");

  out.push("## Existing comments on this PR (untrusted)", "");
  const relevant = c.comments.filter((x) => x.body.trim() !== "");
  if (relevant.length === 0) {
    out.push("None.", "");
  } else {
    out.push("Do not repeat anything raised here.", "");
    const lines = relevant.map((x) => {
      const where = x.path ? ` on ${x.path}${x.line ? `:${x.line}` : " (outdated)"}` : "";
      const reply = x.inReplyTo ? ` (reply to ${x.inReplyTo})` : "";
      return `--- comment ${x.id} by ${x.author.login} [${x.author.type}], ${x.kind}${where}${reply}\n${x.body.trim()}`;
    });
    out.push(untrusted("pr-comments", lines.join("\n\n")), "");
  }

  if (c.priorOpen.length > 0) {
    out.push("## Earlier findings by this bot, still open", "");
    out.push("They are re-checked separately. Do not report them again.", "");
    for (const f of c.priorOpen) {
      const where = f.path ? `${f.path}${f.line ? `:${f.line}` : ""}` : "(no location)";
      out.push(`- ${f.tag ?? "finding"} at \`${cell(where)}\`: ${neutralizeDelimiters(f.title)}`);
    }
    out.push("");
  }
  return out.join("\n");
}

function cell(s: string): string {
  return s.replace(/[|`\n\r]/g, "_");
}
