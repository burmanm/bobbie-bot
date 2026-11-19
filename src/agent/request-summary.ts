/**
 * What was actually sent to the provider, per model call (A-6: "the model
 * ID the provider actually served"; this is the request side). Captured
 * from pi's `before_provider_request` extension event.
 *
 * pi fires that event for real providers: each API implementation in
 * pi-ai (`openai-completions` for OpenRouter, `anthropic-messages`,
 * `openai-responses`, `google-generative-ai`, `bedrock-converse-stream`, …)
 * calls `options.onPayload(params, model)` with the request body just
 * before sending it, and the SDK session routes `onPayload` to the
 * extension runner (pi-coding-agent `core/sdk.js`, `transformProviderPayload`).
 * The scripted ("faux") provider never calls `onPayload`, which is why it
 * did not fire in the R-1 tests.
 *
 * The payload is the request **body**: the API key travels in the client's
 * headers, not here. The summary keeps only shapes and settings (model,
 * counts, tool names, token limit, reasoning and routing settings) plus the
 * body's size and hash, never message text (the run record holds no file
 * contents). Strings are scrubbed of anything token-like anyway.
 */
import { createHash } from "node:crypto";
import { scrubSecrets } from "../../pi-review/extension/index.ts";

export interface ProviderRequestSummary {
  /** Model id as sent. */
  model?: string;
  /** Conversation entries sent (messages / contents / input items). */
  messages?: number;
  toolCount?: number;
  /** Tool names, on the step's first request and whenever they change. */
  toolNames?: string[];
  maxTokens?: number;
  temperature?: number;
  /** Reasoning / thinking settings as sent, JSON, at most 200 characters. */
  reasoning?: string;
  /** Provider routing (OpenRouter `provider`), JSON, at most 300 characters. */
  routing?: string;
  /** UTF-8 bytes of the JSON body. */
  bytes: number;
  /** sha256 of the JSON body, to match a replay against the original request. */
  sha256: string;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function small(v: unknown, max: number): string | undefined {
  if (v === undefined) return undefined;
  const text = scrubSecrets(JSON.stringify(v) ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toolName(t: unknown): string | undefined {
  if (!isObj(t)) return undefined;
  if (isObj(t.function) && typeof t.function.name === "string") return t.function.name;
  if (typeof t.name === "string") return t.name;
  if (isObj(t.toolSpec) && typeof t.toolSpec.name === "string") return t.toolSpec.name;
  return undefined;
}

/** Tool names across API shapes: OpenAI `tools[].function.name`, Anthropic `tools[].name`, Google `tools[].functionDeclarations[].name`, Bedrock `toolConfig.tools[].toolSpec.name`. */
function toolNames(p: Obj): string[] | undefined {
  const google = Array.isArray(p.tools) ? p.tools.flatMap((t) => (isObj(t) && Array.isArray(t.functionDeclarations) ? t.functionDeclarations : [])) : [];
  const list = google.length > 0 ? google : Array.isArray(p.tools) ? p.tools : isObj(p.toolConfig) && Array.isArray(p.toolConfig.tools) ? p.toolConfig.tools : undefined;
  if (list === undefined) return undefined;
  return list.map(toolName).filter((n): n is string => n !== undefined).map((n) => scrubSecrets(n).slice(0, 100));
}

export function summarizeProviderRequest(payload: unknown, previousToolNames?: readonly string[]): ProviderRequestSummary {
  let body: string;
  try {
    body = JSON.stringify(payload) ?? "null";
  } catch {
    body = "[unserializable]";
  }
  const s: ProviderRequestSummary = {
    bytes: Buffer.byteLength(body, "utf8"),
    sha256: createHash("sha256").update(body, "utf8").digest("hex"),
  };
  if (!isObj(payload)) return s;
  const p = payload;
  if (typeof p.model === "string") s.model = scrubSecrets(p.model).slice(0, 200);
  const conv = [p.messages, p.contents, p.input].find(Array.isArray) as unknown[] | undefined;
  if (conv !== undefined) s.messages = conv.length;
  const names = toolNames(p);
  if (names !== undefined) {
    s.toolCount = names.length;
    if (previousToolNames === undefined || previousToolNames.join("\0") !== names.join("\0")) s.toolNames = names;
  }
  const gen = isObj(p.generationConfig) ? p.generationConfig : isObj(p.inferenceConfig) ? p.inferenceConfig : {};
  const maxTokens = num(p.max_tokens) ?? num(p.max_completion_tokens) ?? num(p.max_output_tokens) ?? num(gen.maxOutputTokens) ?? num(gen.maxTokens);
  if (maxTokens !== undefined) s.maxTokens = maxTokens;
  const temperature = num(p.temperature) ?? num(gen.temperature);
  if (temperature !== undefined) s.temperature = temperature;
  const reasoning = p.reasoning ?? p.reasoning_effort ?? p.thinking ?? (isObj(gen.thinkingConfig) ? gen.thinkingConfig : undefined);
  const r = small(reasoning, 200);
  if (r !== undefined) s.reasoning = r;
  const routing = small(p.provider, 300);
  if (routing !== undefined) s.routing = routing;
  return s;
}
