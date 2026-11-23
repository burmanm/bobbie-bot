/**
 * Saved scripts (A-6, F-7 Codemode): `scripts.json`, written next to the run
 * record when a step used codemode, so R-6 can judge the scripts as check
 * candidates.
 *
 * It holds what the model asked to run, never what came back: no script
 * output, and no results or arguments of nested calls. The collector is fed
 * plain event data and takes the scrub function from the caller, so `core`
 * stays free of pi (A-2).
 *
 * Replaying a script takes its source and the record's SHAs. A script that
 * calls `load()` also needs the earlier scripts of its step, which is why
 * they are kept in start order and why dropped ones are counted.
 */
import { Type, type Static } from "typebox";

export const SAVED_SCRIPTS_SCHEMA_VERSION = 1;

/** The file's name, next to the run record (A-6). */
export const SAVED_SCRIPTS_FILE = "scripts.json";

/** The tool whose calls are scripts. */
const SCRIPT_TOOL = "codemode";

export const SCRIPT_OUTCOMES = ["ok", "error", "unfinished"] as const;

export const SavedNestedCall = Type.Object(
  {
    tool: Type.String(),
    /** Absent when the call had not ended when the file was written. */
    isError: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type SavedNestedCall = Static<typeof SavedNestedCall>;

export const SavedScript = Type.Object(
  {
    id: Type.String({ pattern: "^script-[1-9][0-9]*$", description: "Unique in the file; what a finding keeps" }),
    step: Type.String({ description: "StepRecord.name" }),
    toolCallId: Type.String({ description: "The provider's id; can repeat within a step, and is cut when very long" }),
    source: Type.String({ description: "As the model issued it, options line included; scrubbed, then capped" }),
    /** `source` is not the whole script: cut at the cap, or the call carried no text. Not replayable. */
    sourceTruncated: Type.Boolean(),
    /** Something token-like was replaced in `source`. Not faithfully replayable. */
    sourceRedacted: Type.Boolean(),
    outcome: Type.Enum(SCRIPT_OUTCOMES),
    /** Calls at every depth, in start order. `models.*` calls are not tool calls and are not listed. */
    nestedCalls: Type.Array(SavedNestedCall),
    /** `nestedCalls` is only the first part, so a replay cannot be compared with all of it. */
    nestedTruncated: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type SavedScript = Static<typeof SavedScript>;

export const SavedScripts = Type.Object(
  {
    schemaVersion: Type.Literal(SAVED_SCRIPTS_SCHEMA_VERSION),
    scripts: Type.Array(SavedScript),
    /** Scripts left out by the total cap. Their ids are the gaps in the numbering. */
    droppedScripts: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type SavedScripts = Static<typeof SavedScripts>;

/**
 * The fields read from a tool execution event. pi's events fit as they are;
 * results are not part of the type and are never read.
 */
export type ScriptEvent =
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown; parentToolCallId?: string }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; isError: boolean; parentToolCallId?: string };

export interface ScriptLimits {
  /** UTF-8 bytes of one script's source. */
  maxSourceBytes: number;
  /** Nested calls listed for one script. */
  maxNestedCalls: number;
  /** UTF-8 bytes of the whole file as compact JSON. */
  maxTotalBytes: number;
}

export const SCRIPT_LIMITS: Readonly<ScriptLimits> = {
  maxSourceBytes: 64 * 1024,
  maxNestedCalls: 256, // as many as pi records on a tool result
  maxTotalBytes: 1024 * 1024,
};

/** Tool names and call ids come from the provider, a module or a script. */
const MAX_LABEL_BYTES = 512;
/** The file around its entries, with room for the dropped count. */
const ENVELOPE_BYTES = 100;

function cutUtf8(text: string, maxBytes: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, cut: false };
  // `stream` holds back a character the cut split instead of decoding it to U+FFFD.
  const head = new TextDecoder("utf-8", { ignoreBOM: true }).decode(Buffer.from(text, "utf8").subarray(0, maxBytes), { stream: true });
  return { text: head, cut: true };
}

/** An array element's size in compact JSON, with its comma. */
function entryBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
}

interface Tracked {
  id: string;
  /** Absent when the script was dropped; its id still links. */
  saved?: SavedScript;
  /** Listed nested calls that have not ended, by call id. */
  running: Map<string, SavedNestedCall>;
}

/** One per run, shared by its steps so that the total cap covers the file. */
export class ScriptCollector {
  private readonly scrub: (text: string) => string;
  private readonly limits: ScriptLimits;
  /** Step, then the script's tool call id. */
  private readonly steps = new Map<string, Map<string, Tracked>>();
  private readonly saved: SavedScript[] = [];
  private count = 0;
  private bytes = ENVELOPE_BYTES;

  constructor(scrub: (text: string) => string, limits: Partial<ScriptLimits> = {}) {
    this.scrub = scrub;
    this.limits = { ...SCRIPT_LIMITS, ...limits };
  }

  /** Feed every tool execution start and end of a step, nested ones included, in the order they arrive. */
  record(step: string, event: ScriptEvent): void {
    const { toolCallId, parentToolCallId } = event;
    if (parentToolCallId === undefined) {
      if (event.type === "tool_execution_end") {
        const script = this.steps.get(step)?.get(toolCallId)?.saved;
        if (script !== undefined) script.outcome = event.isError ? "error" : "ok";
      } else if (event.toolName === SCRIPT_TOOL) {
        this.startScript(step, toolCallId, event.args);
      } else {
        // Providers can reuse a call id in a later turn; this one is not a script.
        this.steps.get(step)?.delete(toolCallId);
      }
      return;
    }
    const script = this.scriptOf(step, parentToolCallId);
    if (script?.saved === undefined) return;
    if (event.type === "tool_execution_start") {
      this.startNested(script, script.saved, toolCallId, event.toolName);
      return;
    }
    const call = script.running.get(toolCallId);
    if (call === undefined) return;
    call.isError = event.isError;
    script.running.delete(toolCallId);
  }

  /**
   * The id of the script a call was made from, at any depth, given that
   * call's `parentToolCallId`; undefined for a call the model made itself.
   * This is what a finding keeps (A-6). Ask while handling the call's event:
   * a later script can reuse the provider's call id.
   */
  scriptIdOf(step: string, parentToolCallId: string | undefined): string | undefined {
    return parentToolCallId === undefined ? undefined : this.scriptOf(step, parentToolCallId)?.id;
  }

  /** The contents of `scripts.json`, or undefined when no step used codemode. */
  file(): SavedScripts | undefined {
    if (this.count === 0) return undefined;
    return {
      schemaVersion: SAVED_SCRIPTS_SCHEMA_VERSION,
      scripts: structuredClone(this.saved),
      droppedScripts: this.count - this.saved.length,
    };
  }

  private startScript(step: string, toolCallId: string, args: unknown): void {
    const code = (args as { code?: unknown } | null | undefined)?.code;
    const text = typeof code === "string" ? code : "";
    // Scrub before cutting, or a token across the cut would no longer match.
    const scrubbed = this.scrub(text);
    const source = cutUtf8(scrubbed, this.limits.maxSourceBytes);
    const script: SavedScript = {
      id: `script-${++this.count}`,
      step,
      toolCallId: this.label(toolCallId),
      source: source.text,
      sourceTruncated: source.cut || typeof code !== "string",
      sourceRedacted: scrubbed !== text,
      // This and `nestedTruncated: false` are the longest values they can
      // take, so the size charged here cannot be exceeded later.
      outcome: "unfinished",
      nestedCalls: [],
      nestedTruncated: false,
    };
    const tracked: Tracked = { id: script.id, running: new Map() };
    if (this.charge(entryBytes(script))) {
      this.saved.push(script);
      tracked.saved = script;
    }
    let scripts = this.steps.get(step);
    if (scripts === undefined) this.steps.set(step, (scripts = new Map()));
    scripts.set(toolCallId, tracked);
  }

  private startNested(script: Tracked, saved: SavedScript, toolCallId: string, toolName: string): void {
    if (saved.nestedTruncated) return;
    const call: SavedNestedCall = { tool: this.label(toolName) };
    // Charged with the longer flag, which is set when the call ends.
    if (saved.nestedCalls.length >= this.limits.maxNestedCalls || !this.charge(entryBytes({ ...call, isError: false }))) {
      saved.nestedTruncated = true;
      return;
    }
    saved.nestedCalls.push(call);
    script.running.set(toolCallId, call);
  }

  /**
   * pi names a nested call `<parent>/<n>` at every depth. Strip those
   * suffixes one at a time: a provider's own id may contain "/" too.
   */
  private scriptOf(step: string, callId: string): Tracked | undefined {
    const scripts = this.steps.get(step);
    if (scripts === undefined) return undefined;
    let id = callId;
    for (;;) {
      const script = scripts.get(id);
      if (script !== undefined) return script;
      const suffix = /\/\d+$/.exec(id);
      if (suffix === null) return undefined;
      id = id.slice(0, suffix.index);
    }
  }

  private label(text: string): string {
    return cutUtf8(this.scrub(String(text)), MAX_LABEL_BYTES).text;
  }

  private charge(bytes: number): boolean {
    if (this.bytes + bytes > this.limits.maxTotalBytes) return false;
    this.bytes += bytes;
    return true;
  }
}
