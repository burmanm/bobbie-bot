/** Fixture: a provider package (F-7). `fixture-provider/echo` reports one note, then answers. */
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PROVIDER_ANSWER = "FIXTURE-PROVIDER-ANSWER-3301";

export default function (pi: ExtensionAPI): void {
  const faux = fauxProvider({ provider: "fixture-provider", models: [{ id: "echo" }] });
  faux.setResponses(
    Array.from({ length: 20 }, () => (context: { messages: Array<{ role: string }> }) =>
      context.messages.at(-1)?.role === "toolResult"
        ? fauxAssistantMessage(fauxText(PROVIDER_ANSWER))
        : fauxAssistantMessage([fauxToolCall("report_note", { title: PROVIDER_ANSWER, severity: "low", line: 1 })], { stopReason: "toolUse" }),
    ),
  );
  pi.registerProvider(faux.provider);
}
