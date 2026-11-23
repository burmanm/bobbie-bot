/**
 * Replay a saved codemode script (A-6 `scripts.json`, R-6) against a
 * snapshot, without a model: a scripted model issues the saved source as a
 * `codemode` call, so the script runs in an ordinary step, through the same
 * guard, roots, limits and accounting as in the review that saved it.
 *
 * A script that called `load()` needs its step's earlier scripts: pass them
 * as `earlier`, in file order, and they run first in the same session.
 * Scripts whose source was cut or redacted are refused: what would run is
 * not what ran.
 *
 * What the replay cannot reproduce: a module's `tool_call` hook that rewrote
 * a nested call's input, the answers of `models.*` calls, and the files of
 * the run's head unless `roots` is that same snapshot.
 */
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { CODEMODE_TOOL } from "../../pi-review/extension/index.ts";
import { type SavedNestedCall, type SavedScript, ScriptCollector } from "../core/saved-scripts.ts";
import { createPiSdkAgentStep, type PiSdkAgentStepOptions } from "./pi-sdk-step.ts";
import type { AgentStepRequest, AgentStepResult, OutputTool } from "./types.ts";

const REPLAY_PROVIDER = "replay";
const REPLAY_STEP = "replay";

export interface ReplayRequest<T extends OutputTool = OutputTool> {
  script: SavedScript;
  /** The same step's scripts before `script`, in file order (for `load()`). */
  earlier?: readonly SavedScript[];
  /** The step's setup as in the review: roots, tools, limits. Model and prompts are the replay's own. */
  step: Pick<AgentStepRequest<T>, "roots" | "readTools" | "outputTools" | "queryTools" | "moduleTools" | "limits" | "signal">;
  /** Packages, agent directory and codemode settings as in the review. Providers are the replay's own. */
  options?: Omit<PiSdkAgentStepOptions, "providers">;
}

export interface ReplayResult<T extends OutputTool = OutputTool> {
  /** What the script returned to the model, header included. Undefined when it did not run to a result. */
  output?: string;
  isError?: boolean;
  /** The replayed script's nested calls, as `scripts.json` would list them now. */
  nestedCalls: SavedNestedCall[];
  /** Whether `nestedCalls` matches the saved list: same tools, same error flags, in order. */
  sameCalls: boolean;
  step: AgentStepResult<T>;
}

export class ReplayRefused extends Error {
  override name = "ReplayRefused";
}

function textOf(message: { content?: Array<{ type?: string; text?: unknown }> }): string {
  return (message.content ?? []).map((c) => (typeof c.text === "string" ? c.text : "")).join("");
}

export async function replaySavedScript<T extends OutputTool>(request: ReplayRequest<T>): Promise<ReplayResult<T>> {
  const scripts = [...(request.earlier ?? []), request.script];
  for (const s of scripts) {
    if (s.sourceTruncated || s.sourceRedacted) {
      throw new ReplayRefused(`${s.id} cannot be replayed: its saved source is ${s.sourceTruncated ? "incomplete" : "redacted"}`);
    }
  }
  if (request.earlier?.some((s) => s.step !== request.script.step)) {
    throw new ReplayRefused(`earlier scripts must come from the same step as ${request.script.id}`);
  }

  const faux = fauxProvider({ provider: REPLAY_PROVIDER, models: [{ id: "scripted" }] });
  let output: string | undefined;
  let isError: boolean | undefined;
  const lastId = `replay-${scripts.length}`;
  const turns: FauxResponseStep[] = scripts.map((s, i) => (context) => {
    if (i > 0) collectResult(context);
    return fauxAssistantMessage([fauxToolCall(CODEMODE_TOOL, { code: s.source }, { id: `replay-${i + 1}` })], { stopReason: "toolUse" });
  });
  turns.push((context) => {
    collectResult(context);
    return fauxAssistantMessage(fauxText("Replay done."));
  });
  function collectResult(context: unknown): void {
    const messages = (context as { messages?: Array<Record<string, unknown>> }).messages ?? [];
    const result = messages.findLast((m) => m.role === "toolResult" && m.toolCallId === lastId);
    if (result === undefined) return;
    output = textOf(result as never);
    isError = result.isError === true;
  }
  faux.setResponses(turns);

  // The replay's own collector, scrubbed like the review's, to list the nested calls.
  const collector = new ScriptCollector((text) => text);
  const step = createPiSdkAgentStep({ ...(request.options ?? {}), providers: [faux.provider], retry: { enabled: false } });
  const model = faux.getModel();
  const result = await step.run({
    ...request.step,
    role: "reviewer",
    model: { provider: model.provider, id: model.id },
    systemPrompt: "Replay of saved codemode scripts.",
    prompt: `Replay ${request.script.id}.`,
    codemode: true,
    scripts: {
      record: (event) => collector.record(REPLAY_STEP, event),
      scriptIdOf: (parent) => collector.scriptIdOf(REPLAY_STEP, parent),
    },
  });
  const nestedCalls = collector.file()?.scripts.at(-1)?.nestedCalls ?? [];
  const saved = request.script.nestedCalls;
  const sameCalls =
    !request.script.nestedTruncated &&
    nestedCalls.length === saved.length &&
    nestedCalls.every((c, i) => c.tool === saved[i]!.tool && c.isError === saved[i]!.isError);
  return { ...(output === undefined ? {} : { output, isError: isError === true }), nestedCalls, sameCalls, step: result };
}
