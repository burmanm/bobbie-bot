/**
 * Own-comment recognition (D-5, S-7, C-5, H-50). Neither login nor marker
 * proves a comment is the bot's: the Actions login is shared with every other
 * workflow, and any bot that echoes PR text can echo a marker.
 *
 * So the bot writes the id of each review it posts where no comment text can
 * reach: `external_id` of its `ai-review/<name>` check run on the reviewed
 * SHA (`checks: write`; GitHub fills that field itself for workflow jobs).
 *
 * - A summary marker counts in a review whose id the check run on that
 *   review's commit records, made by the App that wrote the review. The
 *   marker must name the same commit.
 * - A finding marker counts on a thread root posted with such a review.
 * - Without a record a marker is plain text: it never skips or narrows a
 *   review, hides a finding or gets a thread resolved.
 *
 * The "review could not complete" comment (S-9) has its own marker, so it is
 * found and updated in place instead of repeated per push. Its marker names
 * the head it was last written for, and that head's check run records the
 * comment id (`review-bot:failure=<id>`), so an echoed marker is never taken
 * for it and another bot's comment is never edited:
 *
 *   <!-- review-bot:failure bot=ai-review/main -->
 *
 * Core's decoder ignores this kind; it carries no state beyond "this is the
 * failure comment of this bot".
 */
import { randomBytes } from "node:crypto";
import { decodeOwnMarker, MARKER_PREFIX } from "../core/index.ts";
import type { PrComment } from "./types.ts";

const BOT_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

export function isBotAuthor(c: Pick<PrComment, "author">): boolean {
  return c.author.type === "Bot";
}

/** A thread root posted by this bot for a finding. */
export function isOwnFindingRoot(c: PrComment, botId: string): boolean {
  return c.kind === "review-comment" && c.inReplyTo === undefined && c.recordedBy === botId && decodeOwnMarker(c.body, "finding", botId) !== undefined;
}

/** `external_id` of the check run of a review. */
export function reviewRecord(reviewId: string): string {
  return `${MARKER_PREFIX}:review=${reviewId}`;
}

/** What recognition needs of a check run. */
export interface RecordingRun {
  external_id?: string | null;
  app?: { slug?: string } | null;
}

/**
 * Set `recordedBy` on this bot's reviews and their thread roots.
 *
 * `runsAt` lists this bot's check runs on a commit. It is asked once per
 * commit, and only for the commit GitHub says a review was made on: an
 * echoed marker must not choose what is looked up (some well-formed SHAs
 * make GitHub answer 500, which would fail the run). `app`, when known, is
 * the App this run acts as, and only its records count.
 */
export async function attributeComments(
  comments: readonly PrComment[],
  botId: string,
  runsAt: (sha: string) => Promise<readonly RecordingRun[]>,
  app?: string,
): Promise<PrComment[]> {
  const runs = new Map<string, readonly RecordingRun[]>();
  const reviews = new Set<string>();
  for (const c of comments) {
    if (c.kind !== "review" || !isBotAuthor(c)) continue;
    const m = decodeOwnMarker(c.body, "summary", botId);
    if (m === undefined || m.sha !== c.commitId) continue;
    let at = runs.get(m.sha);
    if (at === undefined) {
      at = await runsAt(m.sha);
      runs.set(m.sha, at);
    }
    if (isRecordedBy(at, c.author.login, reviewRecord(c.id), app)) reviews.add(c.id);
  }
  return comments.map((c) => {
    if (!isBotAuthor(c) || c.inReplyTo !== undefined) return c;
    // Ids are unique per kind only, so never match an issue comment.
    const review = c.kind === "review" ? c.id : c.kind === "review-comment" ? c.reviewId : undefined;
    return review !== undefined && reviews.has(review) ? { ...c, recordedBy: botId } : c;
  });
}

/**
 * A line that identifies one attempt to post a review. Run id and head SHA
 * are public, so the summary marker cannot: it could be echoed in advance.
 */
export function newPostMarker(): string {
  return `<!-- ${MARKER_PREFIX}:post id=${randomBytes(16).toString("hex")} -->`;
}

/** The failure comment's marker; `sha` is the head it was written for (comments before H-50's fix have none). */
export function failureMarker(botId: string, sha?: string): string {
  if (!BOT_RE.test(botId)) throw new Error(`invalid bot id: ${botId}`);
  if (sha !== undefined && !FAILURE_SHA_RE.test(sha)) throw new Error(`invalid head SHA: ${sha}`);
  return `<!-- review-bot:failure bot=${botId}${sha === undefined ? "" : ` sha=${sha}`} -->`;
}

// 40 hex only: GitHub answers 500 to some well-formed 64-hex SHAs, and the bot reads this one back.
const FAILURE_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * This bot's failure marker in a body: exactly one, on its own line, outside
 * code fences. `sha` when it names one.
 */
export function readFailureMarker(body: string, botId: string): { sha?: string } | undefined {
  const re = /^<!-- review-bot:failure bot=(\S+?)(?: sha=([0-9a-f]{40}))? -->$/;
  let fence: string | undefined;
  const found: Array<{ sha?: string }> = [];
  for (const raw of body.split(/\r?\n/)) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
    if (f) {
      if (fence === undefined) fence = f[1]!;
      else if (f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = undefined;
      continue;
    }
    const m = fence === undefined ? re.exec(raw.trim()) : null;
    if (m && m[1] === botId) found.push(m[2] === undefined ? {} : { sha: m[2] });
  }
  return found.length === 1 ? found[0] : undefined;
}

/** Whether the body holds exactly one failure marker of this bot. */
export function hasFailureMarker(body: string, botId: string): boolean {
  return readFailureMarker(body, botId) !== undefined;
}

/** `external_id` of the check run of the run that wrote a failure comment. */
export function failureRecord(commentId: string): string {
  return `${MARKER_PREFIX}:failure=${commentId}`;
}

/**
 * A candidate for this bot's failure comment: a Bot-authored issue comment
 * whose marker names a head. It is the bot's only if that head's check run
 * records it (`isRecordedBy`).
 */
export function failureCandidate(c: PrComment, botId: string): string | undefined {
  if (c.kind !== "issue-comment" || !isBotAuthor(c)) return undefined;
  return readFailureMarker(c.body, botId)?.sha;
}

/** Whether a check run of the comment's author's App records this value. */
export function isRecordedBy(runs: readonly RecordingRun[], author: string, record: string, app?: string): boolean {
  return runs.some((r) => {
    const slug = r.app?.slug;
    if (slug === undefined || (app !== undefined && slug !== app)) return false;
    return author === `${slug}[bot]` && r.external_id === record;
  });
}

/** Remove marker lines of any kind (for text moved out of its comment). */
export function stripMarkers(body: string): string {
  return body
    .split("\n")
    .filter((l) => !/^\s*<!-- review-bot:[a-z]+ .* -->\s*$/.test(l))
    .join("\n");
}
