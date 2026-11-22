/**
 * Typed query tools (S-4): read-only questions the orchestrator answers for
 * the model, such as history (log, blame, commit diff) and the repository's
 * issues. Like output tools, they are definitions passed in by the caller;
 * this file only registers them.
 *
 * What the extension guarantees for every query tool:
 * - arguments are validated against `parameters` by pi, then by `validate`;
 * - the answer is cut to `maxBytes`, so one call cannot flood the context;
 * - a call ends within `timeoutMs`, and at once when the step is stopped,
 *   even if `run` ignores its signal (a hung call must not hold the step,
 *   S-4 Limits);
 * - error messages are scrubbed of anything that looks like a GitHub token,
 *   as defence in depth: `run` holds whatever credential it needs, the model
 *   never does (C-3).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";

export interface QueryTool<Name extends string = string, Schema extends TSchema = TSchema> {
  name: Name;
  /** Shown to the model as the tool description. */
  description: string;
  parameters: Schema;
  /** One line for the tool list in the system prompt. */
  promptSnippet?: string;
  /** Rules JSON Schema cannot express (scope, ranges). Return a message to reject the call. */
  validate?(value: Static<Schema>): string | undefined;
  /** Answer the query as text. Should stop when `signal` aborts. */
  run(value: Static<Schema>, signal: AbortSignal): Promise<string>;
  /** Per call. Default 30 seconds. */
  timeoutMs?: number;
  /** Answer size cap in UTF-8 bytes. Default 24 KiB. */
  maxBytes?: number;
}

/** What a query tool call carries in `tool_execution_end.result.details`. */
export interface QueryDetails {
  query: string;
  bytes: number;
  truncated: boolean;
}

export const QUERY_DEFAULT_TIMEOUT_MS = 30_000;
export const QUERY_DEFAULT_MAX_BYTES = 24 * 1024;

/**
 * Token forms that are redacted (C-3, C-7, A-6 saved scripts):
 * - an installation token `ghs_<app id>_<JWT>`. A JWT starts "eyJ" (base64url
 *   of `{"`), which is what tells it from an identifier. It needs no word
 *   boundary, so it is also found after an escape such as `\n`, and a token
 *   cut short after ten characters of its header is redacted too;
 * - the opaque forms `gh[opsur]_...` and `github_pat_...`. These need a word
 *   boundary at both ends: "highs_..." contains "ghs_".
 *
 * Linear, which matters as this runs on text a model wrote: nothing that
 * must match follows the JWT's header, and an attempt that fails has only
 * scanned a run of characters in which no other attempt can start.
 */
const TOKEN_LIKE =
  /ghs_\d+_eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+){0,2}|\b(?:gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

export function scrubSecrets(text: string): string {
  return text.replace(TOKEN_LIKE, "[redacted]");
}

/** Cut `text` to at most `maxBytes` UTF-8 bytes at a line boundary when possible, with a note. */
export function capText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false };
  let cut = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  // A cut inside a multi-byte character decodes to U+FFFD; drop it.
  cut = cut.replace(/�$/, "");
  const nl = cut.lastIndexOf("\n");
  if (nl > maxBytes / 2) cut = cut.slice(0, nl);
  return {
    text: `${cut}\n[truncated: ${bytes - Buffer.byteLength(cut, "utf8")} more bytes not shown; narrow the query]`,
    truncated: true,
  };
}

/**
 * Run `fn` with a signal that aborts on `outer`, or after `timeoutMs`; settle
 * as soon as either happens, whether or not `fn` honours the signal.
 */
export async function runBounded<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  outer: AbortSignal | undefined,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onOuter: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    const fail = (message: string) => {
      controller.abort(new Error(message));
      reject(new Error(message));
    };
    if (outer?.aborted) {
      fail(`${what} aborted`);
      return;
    }
    onOuter = () => fail(`${what} aborted`);
    outer?.addEventListener("abort", onOuter, { once: true });
    timer = setTimeout(() => fail(`${what} timed out after ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
  });
  // Keep an abandoned `fn` from surfacing as an unhandled rejection.
  const work = Promise.resolve().then(() => fn(controller.signal));
  work.catch(() => {});
  try {
    return await Promise.race([work, stopped]);
  } finally {
    clearTimeout(timer);
    if (onOuter !== undefined) outer?.removeEventListener("abort", onOuter);
    if (!controller.signal.aborted) controller.abort(new Error(`${what} finished`));
  }
}

export function registerQueryTool(pi: ExtensionAPI, tool: QueryTool): void {
  const timeoutMs = tool.timeoutMs ?? QUERY_DEFAULT_TIMEOUT_MS;
  const maxBytes = tool.maxBytes ?? QUERY_DEFAULT_MAX_BYTES;
  pi.registerTool({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
    parameters: tool.parameters,
    async execute(_toolCallId, params, signal) {
      const problem = tool.validate?.(params);
      if (problem !== undefined) throw new Error(problem);
      let answer: string;
      try {
        answer = await runBounded((s) => tool.run(params, s), signal, timeoutMs, tool.name);
      } catch (e) {
        throw new Error(scrubSecrets(e instanceof Error ? e.message : String(e)));
      }
      const capped = capText(scrubSecrets(answer), maxBytes);
      const details: QueryDetails = { query: tool.name, bytes: Buffer.byteLength(answer, "utf8"), truncated: capped.truncated };
      return { content: [{ type: "text", text: capped.text }], details };
    },
  });
}
