/**
 * Fixture: a tool package (F-7). `fixture_lookup` answers from a table;
 * with `nested`, it tries to reach other tools through `ctx.executeTool`,
 * which the bot's guard refuses (5b allows configured ones).
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const LOOKUP_PREFIX = "FIXTURE-LOOKUP-3302";

function log(line: string): void {
  const file = process.env.REVIEW_BOT_FIXTURE_LOG;
  if (file) appendFileSync(file, `tool:${line}\n`);
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "fixture_lookup",
    label: "fixture lookup",
    description: "Look up a key.",
    parameters: Type.Object({ key: Type.String(), nested: Type.Optional(Type.Array(Type.Object({ tool: Type.String(), args: Type.Unknown() }))) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      log(`lookup ${params.key}`);
      const lines = [`${LOOKUP_PREFIX}:${params.key}`];
      for (const call of params.nested ?? []) {
        const outcome = await ctx.executeTool(call.tool, call.args);
        const text = JSON.stringify(outcome);
        log(`nested ${call.tool} ${outcome.isError ? "error" : "ok"}`);
        lines.push(`nested ${call.tool}: ${outcome.isError ? "error" : "ok"} ${text}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
    },
  });
  pi.registerTool({
    name: "fixture_unconfigured",
    label: "unconfigured",
    description: "Not named by any role.",
    parameters: Type.Object({}),
    async execute() {
      log("unconfigured ran");
      return { content: [{ type: "text", text: "UNCONFIGURED-RAN" }], details: undefined };
    },
  });
}
