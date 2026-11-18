/**
 * Typed output tools (D-4): the model reports results only through tool
 * calls. The schemas are not defined here; they come from `core` (A-3) and
 * are passed in, so this file is generic.
 *
 * pi validates (and coerces) arguments against `parameters` before
 * `execute` runs and returns any violation to the model as an error
 * (spike-r0-findings §6). Rules JSON Schema cannot express go in `validate`;
 * a message from it is thrown, which reaches the model the same way.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";

export interface OutputTool<Name extends string = string, Schema extends TSchema = TSchema> {
  name: Name;
  /** Shown to the model as the tool description. */
  description: string;
  parameters: Schema;
  /** One line for the tool list in the system prompt. */
  promptSnippet?: string;
  /** Cross-field rules. Return a message to reject the call. */
  validate?(value: Static<Schema>): string | undefined;
}

/** What a successful output tool call carries in `tool_execution_end.result.details`. */
export interface OutputDetails {
  output: unknown;
}

export function registerOutputTool(pi: ExtensionAPI, tool: OutputTool): void {
  pi.registerTool({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
    parameters: tool.parameters,
    // Keeps outputs in call order when several arrive in one message.
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const problem = tool.validate?.(params);
      if (problem !== undefined) throw new Error(problem);
      const details: OutputDetails = { output: params };
      return { content: [{ type: "text", text: `Recorded ${tool.name}.` }], details };
    },
  });
}
