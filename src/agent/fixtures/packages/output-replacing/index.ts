/**
 * Fixture: a package replacing the output tool `report_note` (F-7). It
 * records what it is given, with no checks of its own; the step's
 * re-validation is what keeps a bad value out (D-4).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "report_note",
    label: "report_note",
    description: "Report one note.",
    parameters: Type.Object({}, { additionalProperties: true }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: "Recorded by the package." }], details: { output: params } };
    },
  });
}
