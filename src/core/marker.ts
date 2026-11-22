/**
 * Hidden HTML markers (S-7, D-5): the bot's whole per-PR state.
 *
 *   <!-- review-bot:finding bot=ai-review/main run=123 fp=<64 hex> fpv=1 -->
 *   <!-- review-bot:summary bot=ai-review/main run=123 sha=<40|64 hex> fpv=1 -->
 *
 * Every field value is restricted to a small character set, so a value can
 * never close the comment or inject markdown.
 *
 * Decoding treats the comment body as untrusted: anyone can paste a marker
 * into a comment. The parser is strict (own line, not in a blockquote or code
 * block, bounded length, known keys, each key once, validated values) and
 * never throws. It only proves the text is well formed. Another bot can echo
 * a marker (H-50), so the author proves nothing either: the caller must check
 * that the platform found this bot's check-run record for the comment before
 * trusting it as the bot's own state.
 */

export const MARKER_PREFIX = "review-bot";

export type MarkerKind = "finding" | "summary";

export interface FindingMarker {
  kind: "finding";
  bot: string;
  run: string;
  fingerprint: string;
  fingerprintVersion: number;
}

export interface SummaryMarker {
  kind: "summary";
  bot: string;
  run: string;
  /** Last reviewed head SHA. */
  sha: string;
  fingerprintVersion: number;
}

export type Marker = FindingMarker | SummaryMarker;

const VALUE_RE: Record<string, RegExp> = {
  bot: /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/,
  run: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/,
  fp: /^[0-9a-f]{64}$/,
  sha: /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/,
  fpv: /^[1-9][0-9]{0,5}$/,
};
const REQUIRED: Record<MarkerKind, string[]> = {
  finding: ["bot", "run", "fp", "fpv"],
  summary: ["bot", "run", "sha", "fpv"],
};
const MAX_LINE = 400;
const MAX_MARKERS = 20;

export class MarkerError extends Error {
  override name = "MarkerError";
}

function check(key: string, value: string): string {
  if (!VALUE_RE[key]!.test(value)) throw new MarkerError(`invalid marker value for ${key}: ${JSON.stringify(value)}`);
  return value;
}

/** Encode a marker. Throws MarkerError on a value outside the allowed set (a bug on our side). */
export function encodeMarker(m: Marker): string {
  const fields =
    m.kind === "finding"
      ? [
          ["bot", m.bot],
          ["run", m.run],
          ["fp", m.fingerprint],
          ["fpv", String(m.fingerprintVersion)],
        ]
      : [
          ["bot", m.bot],
          ["run", m.run],
          ["sha", m.sha],
          ["fpv", String(m.fingerprintVersion)],
        ];
  const body = fields.map(([k, v]) => `${k}=${check(k!, v!)}`).join(" ");
  return `<!-- ${MARKER_PREFIX}:${m.kind} ${body} -->`;
}

const LINE_RE = /^<!-- review-bot:(finding|summary)((?: [a-z]+=[^\s]+)+) -->$/;

function parseLine(line: string): Marker | undefined {
  if (line.length > MAX_LINE) return undefined;
  const m = LINE_RE.exec(line);
  if (!m) return undefined;
  const kind = m[1] as MarkerKind;
  const values = new Map<string, string>();
  for (const pair of m[2]!.trim().split(" ")) {
    const eq = pair.indexOf("=");
    const k = pair.slice(0, eq);
    const v = pair.slice(eq + 1);
    if (!REQUIRED[kind].includes(k) || values.has(k)) return undefined;
    if (!VALUE_RE[k]!.test(v)) return undefined;
    values.set(k, v);
  }
  if (values.size !== REQUIRED[kind].length) return undefined;
  const fpv = Number(values.get("fpv"));
  if (kind === "finding") {
    return { kind, bot: values.get("bot")!, run: values.get("run")!, fingerprint: values.get("fp")!, fingerprintVersion: fpv };
  }
  return { kind, bot: values.get("bot")!, run: values.get("run")!, sha: values.get("sha")!, fingerprintVersion: fpv };
}

/**
 * All well-formed markers in a comment body, in order. A marker must stand on
 * its own line (surrounding whitespace allowed), outside fenced code blocks.
 * Non-string input yields []. At most a bounded number is returned.
 */
export function decodeMarkers(body: unknown): Marker[] {
  if (typeof body !== "string") return [];
  const out: Marker[] = [];
  let fence: string | undefined;
  for (const raw of body.split(/\r?\n/)) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
    if (f) {
      if (fence === undefined) fence = f[1]!;
      else if (f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const line = raw.trim();
    if (!line.startsWith("<!--")) continue;
    const m = parseLine(line);
    if (m) {
      out.push(m);
      if (out.length >= MAX_MARKERS) break;
    }
  }
  return out;
}

/**
 * The single marker of the given kind and bot in a comment, or undefined when
 * there is none or more than one (ambiguous text is not trusted).
 */
export function decodeMarker<K extends MarkerKind>(body: unknown, kind: K, bot: string): Extract<Marker, { kind: K }> | undefined {
  const found = decodeMarkers(body).filter((m): m is Extract<Marker, { kind: K }> => m.kind === kind && m.bot === bot);
  return found.length === 1 ? found[0] : undefined;
}

/**
 * The marker of a comment already known to be the bot's, or to be checked
 * against its record: the last line, where the bot always puts it, read on
 * its own so that a code fence left open in the text above cannot hide it.
 * Otherwise as `decodeMarker`. Lenient, so never proof of authorship.
 */
export function decodeOwnMarker<K extends MarkerKind>(body: string, kind: K, bot: string): Extract<Marker, { kind: K }> | undefined {
  const last = body.trimEnd().split("\n").pop();
  return decodeMarker(last, kind, bot) ?? decodeMarker(body, kind, bot);
}

/**
 * Neutralize anything marker-like in model- or user-supplied text before it
 * is placed in a comment the bot posts, so the text cannot forge state.
 */
export function neutralizeMarkers(text: string): string {
  return text.replace(/<!--/g, "&lt;!--");
}
