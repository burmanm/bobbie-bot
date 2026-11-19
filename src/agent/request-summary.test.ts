/**
 * Provider request capture (A-6) through `before_provider_request`. pi's
 * faux provider never calls `onPayload`; real API implementations in pi-ai
 * do (see request-summary.ts). The test wraps the faux provider so that it
 * calls `onPayload` with an OpenAI-chat-shaped body, as pi-ai's
 * `openai-completions` does for OpenRouter. No network, no key.
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createPiSdkAgentStep } from "./pi-sdk-step.ts";
import { summarizeProviderRequest } from "./request-summary.ts";
import { declaredToolsIn, noteTool } from "./testing.ts";

let head: string;
before(() => {
  head = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-req-")));
  writeFileSync(join(head, "main.go"), "package main\n");
});
after(() => rmSync(head, { recursive: true, force: true }));

type StreamSimple = (model: { id: string }, context: { messages: unknown[] }, options?: { onPayload?: (p: unknown, m: unknown) => unknown }) => unknown;

/** The faux provider, plus an `onPayload` call with an OpenAI-chat-shaped body before each request. */
function payloadReportingProvider() {
  const faux = fauxProvider();
  const inner = faux.provider as unknown as { streamSimple: StreamSimple };
  const sent: unknown[] = [];
  const provider = {
    ...faux.provider,
    streamSimple: ((model, context, options) => {
      const body = {
        model: model.id,
        messages: [{ role: "system", content: "…" }, ...context.messages],
        // pi declares tools inside the messages (`toolsAdded`); pi-ai's getDeclaredTools collects them the same way.
        tools: declaredToolsIn(context).map((name) => ({ type: "function", function: { name, parameters: {} } })),
        max_tokens: 4096,
        reasoning: { effort: "low" },
        provider: { only: ["anthropic"], allow_fallbacks: false },
        stream: true,
      };
      sent.push(body);
      void options?.onPayload?.(body, model);
      return inner.streamSimple(model, context, options);
    }) as StreamSimple,
  } as unknown as typeof faux.provider;
  return { faux, provider, sent };
}

describe("provider request capture (A-6)", () => {
  test("one summary per model call: model, counts, tool names once, settings, size and hash; no message text", async () => {
    const { faux, provider, sent } = payloadReportingProvider();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("ls", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("SECRET-CONTENT-MARKER done")),
    ]);
    const model = faux.getModel();
    const step = createPiSdkAgentStep({ providers: [provider], retry: { enabled: false } });
    const result = await step.run({
      role: "reviewer",
      model: { provider: model.provider, id: model.id },
      systemPrompt: "Review.",
      prompt: "Look at SECRET-CONTENT-MARKER.",
      roots: { head },
      readTools: ["read", "ls"],
      outputTools: [noteTool],
      limits: { timeoutMs: 20_000, maxTurns: 5 },
    });
    assert.equal(result.outcome, "ok");
    assert.equal(sent.length, 2);
    assert.equal(result.providerRequests.length, 2);
    const [first, second] = result.providerRequests;
    assert.equal(first!.model, model.id);
    assert.deepEqual([...first!.toolNames!].sort(), ["ls", "read", "report_note"]);
    assert.equal(first!.toolCount, 3);
    assert.equal(second!.toolNames, undefined, "unchanged tool names are not repeated");
    assert.equal(second!.toolCount, 3);
    assert.ok(second!.messages! > first!.messages!);
    assert.equal(first!.maxTokens, 4096);
    assert.equal(first!.reasoning, '{"effort":"low"}');
    assert.equal(first!.routing, '{"only":["anthropic"],"allow_fallbacks":false}');
    assert.match(first!.sha256, /^[0-9a-f]{64}$/);
    assert.ok(first!.bytes > 100);
    assert.doesNotMatch(JSON.stringify(result.providerRequests), /SECRET-CONTENT-MARKER/);
  });

  test("the scripted provider reports no request body, so nothing is captured", async () => {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage(fauxText("done"))]);
    const model = faux.getModel();
    const result = await createPiSdkAgentStep({ providers: [faux.provider], retry: { enabled: false } }).run({
      role: "reviewer",
      model: { provider: model.provider, id: model.id },
      systemPrompt: "Review.",
      prompt: "Go.",
      roots: { head },
      readTools: ["read"],
      outputTools: [noteTool],
      limits: { timeoutMs: 20_000, maxTurns: 5 },
    });
    assert.deepEqual(result.providerRequests, []);
  });

  test("other API shapes: Anthropic, Google, Bedrock; token-like strings scrubbed", () => {
    const anthropic = summarizeProviderRequest({ model: "claude-x", messages: [1, 2], tools: [{ name: "read" }], max_tokens: 10, thinking: { type: "enabled", budget_tokens: 1024 } });
    assert.deepEqual(anthropic.toolNames, ["read"]);
    assert.equal(anthropic.reasoning, '{"type":"enabled","budget_tokens":1024}');
    const google = summarizeProviderRequest({ contents: [1], tools: [{ functionDeclarations: [{ name: "grep" }] }], generationConfig: { maxOutputTokens: 7, temperature: 0.2 } });
    assert.deepEqual([google.messages, google.toolNames, google.maxTokens, google.temperature], [1, ["grep"], 7, 0.2]);
    const bedrock = summarizeProviderRequest({ messages: [], toolConfig: { tools: [{ toolSpec: { name: "find" } }] }, inferenceConfig: { maxTokens: 5 } });
    assert.deepEqual([bedrock.toolNames, bedrock.maxTokens], [["find"], 5]);
    const leaky = summarizeProviderRequest({ model: "m", provider: { note: `ghp_${"x".repeat(36)}` } });
    assert.doesNotMatch(leaky.routing!, /ghp_/);
  });
});
