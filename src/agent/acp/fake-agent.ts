/**
 * A scripted ACP agent for tests: speaks ACP over stdio and plays one
 * scenario (argv[2]). No model, no network. What it gets back from the
 * client is written as JSON lines to the file in FAKE_ACP_LOG.
 */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const scenario = process.argv[2] ?? "outputs";
const logFile = process.env.FAKE_ACP_LOG;
const log = (entry: unknown) => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
};

let nextId = 1000;
const waiting = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>();
const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const call = (method: string, params: unknown) =>
  new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
const update = (sessionId: string, u: Record<string, unknown>) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const say = (sessionId: string, text: string) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

let prompts = 0;
let cancelled = false;
let cancelPrompt: (() => void) | undefined;
const untilCancelled = () => (cancelled ? Promise.resolve() : new Promise<void>((resolve) => (cancelPrompt = resolve)));

log({ env: { GH_TOKEN: process.env.GH_TOKEN ?? null, FAKE_EXTRA: process.env.FAKE_EXTRA ?? null }, cwd: process.cwd() });

async function onRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "initialize":
      if (scenario === "exit") process.exit(3);
      log({ initialize: params });
      return { protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: "fake-agent", version: "9.9.9" } };
    case "session/new":
      if (scenario === "auth") throw { code: -32000, message: "Authentication required" };
      return { sessionId: "s1", models: { currentModelId: "fake-model-1", availableModels: [] } };
    case "session/prompt": {
      const sessionId = params.sessionId as string;
      prompts++;
      const text = (params.prompt as Array<{ text: string }>)[0]!.text;
      log({ prompt: prompts, text });
      if (scenario === "hang") {
        await untilCancelled();
        return { stopReason: "cancelled" };
      }
      if (scenario === "deaf") return new Promise(() => {});
      if (scenario === "loop") {
        for (let i = 0; i < 20 && !cancelled; i++) {
          update(sessionId, { sessionUpdate: "tool_call", toolCallId: `t${i}`, title: "Read file", kind: "read", status: "completed" });
          await new Promise((r) => setTimeout(r, 5));
        }
        await untilCancelled();
        return { stopReason: "cancelled" };
      }
      if (prompts === 1) {
        update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run go test", kind: "execute", status: "pending" });
        log({ execute: await call("session/request_permission", permission(sessionId, "t1", "execute")) });
        log({ read: await call("session/request_permission", permission(sessionId, "t2", "read")) });
        log({ inside: await call("fs/read_text_file", { sessionId, path: "main.go", line: 2, limit: 1 }) });
        log({ outside: await call("fs/read_text_file", { sessionId, path: "/etc/hosts" }) });
        log({ write: await call("fs/write_text_file", { sessionId, path: "main.go", content: "x" }) });
        update(sessionId, { sessionUpdate: "usage_update", used: 100, size: 1000, cost: { amount: 0.01, currency: "USD" } });
        say(sessionId, "Looked around.\n\n```json\n");
        say(sessionId, JSON.stringify({ outputs: [
          { tool: "report_note", arguments: { title: "good", severity: "high", line: 2 } },
          { tool: "report_note", arguments: { title: "bad", severity: "huge", line: 2 } },
          { tool: "write_file", arguments: {} },
        ] }));
        say(sessionId, "\n```\n");
        return { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
      }
      update(sessionId, { sessionUpdate: "usage_update", used: 200, size: 1000, cost: { amount: 0.02, currency: "USD" } });
      say(sessionId, '```json\n{"outputs": [{"tool": "report_note", "arguments": {"title": "fixed", "severity": "low", "line": 3}}]}\n```');
      return { stopReason: "end_turn", usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } };
    }
    default:
      throw { code: -32601, message: `no ${method}` };
  }
}

function permission(sessionId: string, toolCallId: string, kind: string) {
  return {
    sessionId,
    toolCall: { toolCallId, title: kind, kind },
    options: [
      { optionId: "yes", name: "Allow", kind: "allow_once" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ],
  };
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
  if (msg.method === undefined) {
    waiting.get(msg.id!)?.(msg);
    waiting.delete(msg.id!);
    return;
  }
  if (msg.id === undefined) {
    if (msg.method === "session/cancel") {
      log({ cancel: true });
      cancelled = true;
      cancelPrompt?.();
    }
    return;
  }
  const id = msg.id;
  onRequest(msg.method, msg.params ?? {}).then(
    (result) => send({ jsonrpc: "2.0", id, result }),
    (error: { code: number; message: string }) => send({ jsonrpc: "2.0", id, error }),
  );
});
