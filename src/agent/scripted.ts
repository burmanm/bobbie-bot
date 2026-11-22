/**
 * A scripted model provider built on pi's faux provider, for offline runs:
 * the end-to-end pipeline tests and `review-bot review --script`. No network,
 * no key (AGENTS.md).
 *
 * One model per role (`scripted/reviewer`, `scripted/verifier`); each has its
 * own queue of turns, consumed in order across that role's steps. When a
 * queue is empty the model answers "Done." and the step ends.
 */
import {
  fauxAssistantMessage,
  type FauxContentBlock,
  fauxProvider,
  type FauxResponseFactory,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ModelRef } from "./types.ts";

export const SCRIPTED_PROVIDER = "scripted";

/**
 * One assistant turn: text, tool calls, or (in code only) a factory.
 * `delayMs` holds the answer back that long, as a slow model would; an abort
 * ends the wait (used to stop a run mid-step, F-3).
 */
export type ScriptTurn =
  | { text?: string; toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>; delayMs?: number }
  | FauxResponseFactory;

function wait(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((done) => {
    if (signal?.aborted) return done(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      done(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      done(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Model id (usually the role name) → its turns. */
export type Script = Record<string, ScriptTurn[]>;

export interface ScriptedProvider {
  provider: ReturnType<typeof fauxProvider>["provider"];
  /** `scripted/<id>` for each scripted model. */
  model(id: string): ModelRef;
  /** Turns not yet consumed, per model id. */
  remaining(): Record<string, number>;
  /** Model ids in the order they were called. */
  calls: string[];
}

export function createScriptedProvider(script: Script): ScriptedProvider {
  const queues = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
  const ids = [...queues.keys()];
  if (ids.length === 0) throw new Error("the script names no models");
  const faux = fauxProvider({ provider: SCRIPTED_PROVIDER, models: ids.map((id) => ({ id })) });
  const calls: string[] = [];
  let seq = 0;

  const router: FauxResponseFactory = (context, options, state, model) => {
    calls.push(model.id);
    const turn = queues.get(model.id)?.shift();
    if (turn === undefined) return fauxAssistantMessage(fauxText("Done."));
    if (typeof turn === "function") return turn(context, options, state, model);
    if (turn.delayMs !== undefined && turn.delayMs > 0) {
      const { delayMs, ...rest } = turn;
      return wait(delayMs, options?.signal).then((done) =>
        done ? answer(rest) : fauxAssistantMessage([], { stopReason: "aborted", errorMessage: "Request was aborted" }),
      );
    }
    return answer(turn);
  };
  const answer = (turn: Exclude<ScriptTurn, FauxResponseFactory>) => {
    const blocks: FauxContentBlock[] = [];
    if (turn.text !== undefined) blocks.push(fauxText(turn.text));
    for (const call of turn.toolCalls ?? []) blocks.push(fauxToolCall(call.name, call.arguments as never, { id: `call-${++seq}` }));
    if (blocks.length === 0) blocks.push(fauxText("Done."));
    return fauxAssistantMessage(blocks, { stopReason: (turn.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop" });
  };
  // Every request goes through the router; it picks the queue by model id.
  faux.setResponses(Array.from({ length: 10_000 }, () => router));

  return {
    provider: faux.provider,
    model: (id) => ({ provider: SCRIPTED_PROVIDER, id }),
    remaining: () => Object.fromEntries([...queues].map(([k, v]) => [k, v.length])),
    calls,
  };
}
