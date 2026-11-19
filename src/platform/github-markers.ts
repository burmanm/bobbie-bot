/**
 * Own-comment recognition for the live platform (S-7, C-5): a comment is the
 * bot's only when its author is Bot-type **and** it carries this bot's
 * marker. Never by login alone: under the Actions token the login
 * (`github-actions[bot]`) is shared with every other workflow. Core's marker
 * decode proves the text well formed; the author check is ours.
 *
 * The "review could not complete" comment (S-9) has its own marker, so it is
 * found and updated in place instead of repeated per push:
 *
 *   <!-- review-bot:failure bot=ai-review/main -->
 *
 * Core's decoder ignores this kind; it carries no state beyond "this is the
 * failure comment of this bot".
 */
import { decodeMarker } from "../core/index.ts";
import type { PrComment } from "./types.ts";

const BOT_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

export function isBotAuthor(c: Pick<PrComment, "author">): boolean {
  return c.author.type === "Bot";
}

/** A thread root posted by this bot for a finding. */
export function isOwnFindingRoot(c: PrComment, botId: string): boolean {
  return c.kind === "review-comment" && c.inReplyTo === undefined && isBotAuthor(c) && decodeMarker(c.body, "finding", botId) !== undefined;
}

export function failureMarker(botId: string): string {
  if (!BOT_RE.test(botId)) throw new Error(`invalid bot id: ${botId}`);
  return `<!-- review-bot:failure bot=${botId} -->`;
}

/** Whether the body holds exactly this bot's failure marker on its own line, outside code fences. */
export function hasFailureMarker(body: string, botId: string): boolean {
  const marker = failureMarker(botId);
  let fence: string | undefined;
  let count = 0;
  for (const raw of body.split(/\r?\n/)) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
    if (f) {
      if (fence === undefined) fence = f[1]!;
      else if (f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence === undefined && raw.trim() === marker) count++;
  }
  return count === 1;
}

/** This bot's failure comment: a Bot-authored issue comment with its failure marker. */
export function isOwnFailureComment(c: PrComment, botId: string): boolean {
  return c.kind === "issue-comment" && isBotAuthor(c) && hasFailureMarker(c.body, botId);
}

/** Remove marker lines of any kind (for text moved out of its comment). */
export function stripMarkers(body: string): string {
  return body
    .split("\n")
    .filter((l) => !/^\s*<!-- review-bot:[a-z]+ .* -->\s*$/.test(l))
    .join("\n");
}
