/**
 * Typed outputs (D-4) for an ACP agent. We cannot register tools in another
 * agent, so the output tools are described in the prompt and the agent ends
 * its answer with one JSON block of calls. Each call is checked like a pi
 * tool call: known tool, schema, then the tool's cross-field rules.
 */
import { Value } from "typebox/value";
import type { OutputTool, RejectedCall } from "../types.ts";

export interface ParsedCall {
  tool: string;
  arguments: unknown;
}

export const OUTPUT_FORMAT = `When you have finished, end your answer with exactly one fenced \`\`\`json block of this shape, and nothing after it:

\`\`\`json
{"outputs": [{"tool": "<output tool name>", "arguments": { ... }}]}
\`\`\`

Each entry is one call of an output tool. Use an empty list if you have nothing to report. Do not write or change any file and do not run commands; read only.`;

/** The output tool definitions as the agent sees them: name, description, JSON Schema. */
export function describeOutputTools(tools: readonly OutputTool[]): string {
  return tools
    .map((t) => `### ${t.name}\n\n${t.description}\n\nArguments (JSON Schema):\n\n\`\`\`json\n${JSON.stringify(t.parameters)}\n\`\`\``)
    .join("\n\n");
}

/** The last fenced json block, or the whole text when it is plain JSON. */
export function extractCalls(text: string): { calls: ParsedCall[] } | { error: string } {
  const fences = [...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/g)];
  const candidate = fences.length > 0 ? fences[fences.length - 1]![1]! : text.trim();
  let data: unknown;
  try {
    data = JSON.parse(candidate);
  } catch (e) {
    return { error: `the final json block is not valid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  const list = Array.isArray(data) ? data : (data as { outputs?: unknown } | null)?.outputs;
  if (!Array.isArray(list)) return { error: 'the final json block has no "outputs" list' };
  const calls: ParsedCall[] = [];
  for (const [i, entry] of list.entries()) {
    const e = entry as { tool?: unknown; name?: unknown; arguments?: unknown } | null;
    const tool = typeof e?.tool === "string" ? e.tool : typeof e?.name === "string" ? e.name : undefined;
    if (tool === undefined) return { error: `outputs[${i}] has no "tool" name` };
    calls.push({ tool, arguments: e!.arguments });
  }
  return { calls };
}

export type CheckedCall =
  | { ok: true; tool: string; value: unknown }
  | { ok: false; rejection: Omit<RejectedCall, "toolCallId"> };

export function checkCall(call: ParsedCall, tools: ReadonlyMap<string, OutputTool>): CheckedCall {
  const tool = tools.get(call.tool);
  if (tool === undefined) {
    return { ok: false, rejection: { tool: call.tool, kind: "not-allowed", reason: `"${call.tool}" is not an output tool` } };
  }
  if (!Value.Check(tool.parameters, call.arguments)) {
    const errors = [...Value.Errors(tool.parameters, call.arguments)].slice(0, 5).map((e) => `${e.instancePath || "/"}: ${e.message}`);
    return { ok: false, rejection: { tool: call.tool, kind: "schema", reason: `Validation failed: ${errors.join("; ")}` } };
  }
  const problem = tool.validate?.(call.arguments);
  if (problem !== undefined) return { ok: false, rejection: { tool: call.tool, kind: "validator", reason: problem } };
  return { ok: true, tool: tool.name, value: call.arguments };
}
