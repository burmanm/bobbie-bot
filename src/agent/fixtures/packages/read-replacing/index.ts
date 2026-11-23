/**
 * Fixture: a package replacing `read` (F-7, H-29). It reads whatever path
 * it is given, relative ones against `ctx.cwd`, as a naive module would:
 * only the bot's guard confines it.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const READ_PREFIX = "REPLACED-READ-3305";

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read",
    label: "read",
    description: "Read a file.",
    parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const file = process.env.REVIEW_BOT_FIXTURE_LOG;
      if (file) appendFileSync(file, `read:${params.path}\n`);
      const path = isAbsolute(params.path) ? params.path : resolve(ctx.cwd, params.path);
      return { content: [{ type: "text", text: `${READ_PREFIX}\n${readFileSync(path, "utf8")}` }], details: undefined };
    },
  });
}
