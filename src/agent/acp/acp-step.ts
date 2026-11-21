/**
 * `AgentStep` over the Agent Client Protocol: the step runs in another
 * agent (any ACP agent: an adapter for Claude Code, Codex, Gemini CLI, …)
 * that review-bot starts as a subprocess and talks to over stdio. One
 * process and one ACP session per step.
 *
 * What differs from the pi step, and why (see src/agent/README.md):
 * - **Isolation is weaker than C-3a.** The agent brings its own tools,
 *   system prompt and configuration. We offer it only `fs/read_text_file`
 *   confined to the read roots, no terminal and no file writes, start it in
 *   a workspace of links to the read roots (`createWorkspace`), deny every
 *   permission request that is not a read,
 *   search or think, and keep GitHub tokens out of its environment. Tools
 *   the agent runs without asking are outside our control.
 * - **Outputs come back as a JSON block** in the agent's last message, not
 *   as tool calls; they are checked against the same schemas and rules.
 *   Rejected calls are sent back once more for correction.
 * - **Turns** are not visible over ACP: a prompt round and each tool call
 *   the agent reports count as one turn each.
 * - **Usage and cost** are recorded only when the agent reports them
 *   (`usage` on the prompt response, `usage_update` notifications);
 *   otherwise `usageComplete` is false and the cost is 0.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalize } from "../../../pi-review/extension/paths.ts";
import { BOT_VERSION } from "../../core/version.ts";
import { AllowedRoots, READ_TOOLS } from "../../../pi-review/extension/index.ts";
import type {
  AgentStep,
  AgentStepRequest,
  AgentStepResult,
  OutputTool,
  StoppedBy,
  ToolOutput,
} from "../types.ts";
import { AcpConnection, AgentExitedError, AUTH_REQUIRED, INVALID_PARAMS, METHOD_NOT_FOUND, RESOURCE_NOT_FOUND, RpcError } from "./connection.ts";
import { checkCall, describeOutputTools, extractCalls, OUTPUT_FORMAT } from "./outputs.ts";
import { stopReasonOf } from "../limits.ts";

/** The provider name that selects an ACP agent: model `acp/<agent name>`. */
export const ACP_PROVIDER = "acp";

export const ACP_PROTOCOL_VERSION = 1;

/** How to start one ACP agent. Operator configuration only, never from the reviewed repository. */
export interface AcpAgentConfig {
  command: string;
  args?: string[];
  /** Added to the agent's environment. */
  env?: Record<string, string>;
  /** Model to select with `session/set_model`, when the agent offers model selection. */
  model?: string;
}

export interface AcpAgentStepOptions {
  /** Agent name → how to start it. A step's model `acp/<name>` picks one. */
  agents: Readonly<Record<string, AcpAgentConfig>>;
  /** Extra prompt rounds to correct rejected outputs. Default 1. */
  maxCorrections?: number;
  /** How long to wait for the agent to answer a cancel before killing it. */
  abortGraceMs?: number;
}

/** Tool kinds (ACP `ToolKind`) a permission request is granted for. */
const ALLOWED_KINDS = new Set(["read", "search", "think"]);

/** Never handed to the agent (C-5): the bot's GitHub and CI credentials. */
const WITHHELD_ENV = ["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL"];

const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

class ConfigError extends Error {}

export function createAcpAgentStep(options: AcpAgentStepOptions): AgentStep {
  return { run: (request) => runStep(request, options) };
}

function agentEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of WITHHELD_ENV) delete env[k];
  return { ...env, ...extra };
}

/** The read roots in workspace order; the workspace has one link per root, named after it. */
const ROOT_NAMES = ["head", "base", "modcache", "inputs"] as const;
type RootName = (typeof ROOT_NAMES)[number];

/**
 * The agent's working directory: a fresh directory next to the head
 * snapshot holding one symlink per read root (`head`, `base`, `modcache`,
 * `inputs`). Agents such as bob confine their own tools to the workspace
 * and never call `fs/read_text_file`, so roots outside the working
 * directory would be unreachable. The links resolve to the real roots, so
 * `AllowedRoots` (canonical paths) checks them as before. It is created
 * beside head because the pipeline placed head where C-3a holds (no `.git`
 * or context file above it).
 */
function createWorkspace(roots: Partial<Record<RootName, string>>): string {
  const ws = realpathSync(mkdtempSync(join(dirname(roots.head!), "acp-workspace-")));
  for (const name of ROOT_NAMES) {
    const target = roots[name];
    if (target !== undefined) symlinkSync(target, join(ws, name), "dir");
  }
  return ws;
}

const ROOT_NOTES: Record<RootName, string> = {
  head: "the PR head; paths in your outputs are relative to it",
  base: "the base branch",
  modcache: "dependency source cache",
  inputs: "review inputs prepared for you, not part of the repository",
};

function composePrompt(request: AgentStepRequest<OutputTool>, ws: string): string {
  const roots = ROOT_NAMES.filter((n) => request.roots[n] !== undefined).map((n) => `${n}: ${join(ws, n)} (${ROOT_NOTES[n]})`);
  return [
    `<instructions>\n${request.systemPrompt}\n</instructions>`,
    `<read_roots>\nYour working directory is ${ws}. It holds one directory per read root, listed below; where the instructions call the PR head your working directory, use ${join(ws, "head")}. Read only inside these directories. Search inside a root directory (for example ${join(ws, "head")}), not the working directory itself: the roots are links that a search from the top may not follow. Evidence and locations still name the root and a path relative to it.\n${roots.join("\n")}\n</read_roots>`,
    `<output_tools>\nReport results only through these output tools.\n\n${describeOutputTools(request.outputTools)}\n\n${OUTPUT_FORMAT}\n</output_tools>`,
    `<task>\n${request.prompt}\n</task>`,
  ].join("\n\n");
}

function validateRequest(request: AgentStepRequest<OutputTool>): void {
  const { limits } = request;
  if (!(limits.maxTurns >= 1)) throw new ConfigError("limits.maxTurns must be at least 1");
  if (!(limits.timeoutMs > 0)) throw new ConfigError("limits.timeoutMs must be positive");
  if (limits.idleTimeoutMs !== undefined && !(limits.idleTimeoutMs > 0)) throw new ConfigError("limits.idleTimeoutMs must be positive");
  if (request.model.routing !== undefined) {
    throw new ConfigError(`routing preferences are supported only for openrouter, not "${request.model.provider}"`);
  }
  for (const t of request.readTools) {
    if (!(READ_TOOLS as readonly string[]).includes(t)) throw new ConfigError(`unknown read tool: ${t}`);
  }
  const names = new Set<string>();
  for (const t of request.outputTools) {
    if (!TOOL_NAME.test(t.name)) throw new ConfigError(`invalid output tool name: ${t.name}`);
    if (names.has(t.name)) throw new ConfigError(`duplicate tool name: ${t.name}`);
    names.add(t.name);
  }
}

function emptyResult<T extends OutputTool>(): AgentStepResult<T> {
  return {
    outcome: "ok",
    outputs: [],
    rejectedCalls: [],
    toolCalls: { total: 0, failed: 0 },
    usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, costIsBilled: false, usageComplete: false, wallMs: 0 },
    servedModels: [],
    providerRequests: [],
    harness: { name: "acp", version: "unknown", extensions: [], tools: [] },
  };
}

interface PromptUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

async function runStep<T extends OutputTool>(request: AgentStepRequest<T>, options: AcpAgentStepOptions): Promise<AgentStepResult<T>> {
  const started = performance.now();
  const result = emptyResult<T>();
  const finish = (): AgentStepResult<T> => {
    result.usage.wallMs = Math.round(performance.now() - started);
    return result;
  };
  const fail = (kind: "provider" | "config" | "internal", message: string): AgentStepResult<T> => {
    result.outcome = "error";
    result.error = { kind, message };
    return finish();
  };
  if (request.signal?.aborted) {
    result.stoppedBy = stopReasonOf(request.signal);
    result.outcome = result.stoppedBy === "deadline" ? "timeout" : "cancelled";
    return finish();
  }

  const agentName = request.model.id;
  let roots: AllowedRoots;
  let agent: AcpAgentConfig;
  try {
    if (request.model.provider !== ACP_PROVIDER) throw new ConfigError(`not an ACP model: ${request.model.provider}/${request.model.id}`);
    const configured = Object.hasOwn(options.agents, agentName) ? options.agents[agentName] : undefined;
    if (configured === undefined) {
      const known = Object.keys(options.agents);
      throw new ConfigError(`unknown ACP agent "${agentName}"${known.length ? ` (configured: ${known.join(", ")})` : "; none is configured"}`);
    }
    agent = configured;
    validateRequest(request);
    roots = new AllowedRoots([request.roots.head, ...[request.roots.base, request.roots.modcache, request.roots.inputs].filter((r): r is string => r !== undefined)]);
  } catch (e) {
    return fail("config", e instanceof Error ? e.message : String(e));
  }
  let ws: string;
  try {
    ws = createWorkspace(request.roots);
  } catch (e) {
    return fail("config", `cannot create the ACP agent's workspace next to ${request.roots.head}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const outputTools = new Map<string, OutputTool>(request.outputTools.map((t) => [t.name, t]));
  result.harness.tools = [...outputTools.keys()];

  const { limits } = request;
  let sessionId: string | undefined;
  let stoppedBy: StoppedBy | undefined;
  let turns = 0;
  let rounds = 0;
  let costReported = false;
  let usageRounds = 0;
  let roundText = "";
  let lastTool: string | undefined;
  let rejectionSeq = 0;
  const failedToolCalls = new Set<string>();
  let onStopped: () => void = () => {};
  const stopped = new Promise<void>((resolve) => (onStopped = resolve));

  const progress = () =>
    request.onProgress?.({ turns, costUsd: result.usage.costUsd, ...(lastTool === undefined ? {} : { lastTool }) });
  const guardReject = (tool: string, reason: string, toolCallId = `acp-guard-${++rejectionSeq}`) => {
    result.rejectedCalls.push({ toolCallId, tool, kind: "guard", reason });
  };

  let conn: AcpConnection | undefined;
  const stop = (reason: StoppedBy) => {
    if (stoppedBy !== undefined) return;
    stoppedBy = reason;
    onStopped();
    if (sessionId !== undefined) conn?.notify("session/cancel", { sessionId });
  };
  const countTurn = () => {
    turns++;
    if (turns > limits.maxTurns) stop("turns");
  };

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => {
    if (limits.idleTimeoutMs === undefined || stoppedBy !== undefined) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop("idle"), limits.idleTimeoutMs);
  };

  /**
   * Relative paths are relative to the workspace, the agent's cwd. The
   * workspace directory itself only lists the root names, so it is allowed
   * too (a permission request to list it, say); a file read of it fails.
   */
  const checkPath = (raw: unknown) => {
    if (typeof raw === "string" && canonicalize(resolve(ws, raw)) === ws) return { ok: true as const, path: ws };
    return roots.check(raw, ws);
  };

  const onRequest = async (method: string, params: unknown): Promise<unknown> => {
    resetIdle();
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "session/request_permission": {
        const toolCall = (p.toolCall ?? {}) as { toolCallId?: string; kind?: string; title?: string; locations?: Array<{ path?: unknown }> };
        const opts = (Array.isArray(p.options) ? p.options : []) as Array<{ optionId: string; kind: string }>;
        const kind = toolCall.kind ?? "other";
        const outsidePath = (toolCall.locations ?? []).map((l) => checkPath(l.path)).find((c) => !c.ok);
        const allowed = ALLOWED_KINDS.has(kind) && outsidePath === undefined;
        const pick = allowed
          ? opts.find((o) => o.kind === "allow_once") ?? opts.find((o) => o.kind === "allow_always")
          : opts.find((o) => o.kind === "reject_once") ?? opts.find((o) => o.kind === "reject_always");
        if (!allowed) {
          const why = outsidePath !== undefined && !outsidePath.ok ? outsidePath.reason : `"${kind}" tools are not allowed in a review (read only)`;
          guardReject(toolCall.title ?? kind, why, toolCall.toolCallId);
        }
        return pick === undefined ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: pick.optionId } };
      }
      case "fs/read_text_file": {
        const check = checkPath(p.path);
        if (!check.ok) {
          guardReject("fs/read_text_file", check.reason);
          throw new RpcError(INVALID_PARAMS, check.reason);
        }
        let text: string;
        try {
          if (check.path === ws) throw new Error(`${ws} is a directory`);
          text = readFileSync(roots.resolveForAccess(check.path), "utf8");
        } catch (e) {
          throw new RpcError(RESOURCE_NOT_FOUND, e instanceof Error ? e.message : String(e));
        }
        const line = typeof p.line === "number" && p.line >= 1 ? p.line : undefined;
        const limit = typeof p.limit === "number" && p.limit >= 0 ? p.limit : undefined;
        if (line === undefined && limit === undefined) return { content: text };
        const lines = text.split("\n");
        const from = (line ?? 1) - 1;
        return { content: lines.slice(from, limit === undefined ? undefined : from + limit).join("\n") };
      }
      default:
        // fs/write_text_file, terminal/*: not offered, so not served.
        guardReject(method, `${method} is not available in a review (read only)`);
        throw new RpcError(METHOD_NOT_FOUND, `${method} is not supported by this client`);
    }
  };

  const onNotification = (method: string, params: unknown): void => {
    resetIdle();
    if (method !== "session/update") return;
    const p = params as { sessionId?: string; update?: Record<string, unknown> } | undefined;
    if (p?.sessionId !== sessionId || p?.update === undefined) return;
    const u = p.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const c = u.content as { type?: string; text?: unknown } | undefined;
        if (c?.type === "text" && typeof c.text === "string") roundText += c.text;
        break;
      }
      case "tool_call": {
        result.toolCalls.total++;
        lastTool = typeof u.title === "string" ? u.title : typeof u.kind === "string" ? u.kind : "tool";
        if (u.status === "failed" && typeof u.toolCallId === "string") failedToolCalls.add(u.toolCallId);
        countTurn();
        progress();
        break;
      }
      case "tool_call_update": {
        if (u.status === "failed" && typeof u.toolCallId === "string") failedToolCalls.add(u.toolCallId);
        break;
      }
      case "usage_update": {
        const cost = u.cost as { amount?: unknown; currency?: unknown } | undefined;
        if (cost !== undefined && cost.currency === "USD" && typeof cost.amount === "number") {
          costReported = true;
          result.usage.costUsd = cost.amount;
          if (limits.maxCostUsd !== undefined && cost.amount >= limits.maxCostUsd) stop("cost");
          progress();
        }
        break;
      }
    }
  };

  const timeout = setTimeout(() => stop("timeout"), limits.timeoutMs);
  const onCancel = () => stop(stopReasonOf(request.signal));
  request.signal?.addEventListener("abort", onCancel, { once: true });
  resetIdle();

  let settled = true;
  /**
   * Resolves with the request's result, or with "stopped" when a limit or
   * cancellation stopped the step and the agent did not answer within the
   * grace period (it is killed in `finally`).
   */
  const untilStopped = async <R>(p: Promise<R>): Promise<R | "stopped"> => {
    const grace = stopped.then(() => new Promise<"stopped">((r) => setTimeout(() => r("stopped"), options.abortGraceMs ?? 10_000).unref()));
    const r = await Promise.race([p, grace]);
    if (r === "stopped") settled = false;
    return r;
  };
  /** Before a session exists there is nothing to cancel, so setup stops at once. */
  const setupStopped = new Promise<"stopped">((r) => void stopped.then(() => r("stopped")));
  const duringSetup = <R>(p: Promise<R>): Promise<R | "stopped"> => Promise.race([p, setupStopped]);
  try {
    conn = new AcpConnection({ command: agent.command, args: agent.args ?? [], cwd: ws, env: agentEnv(agent.env), onRequest, onNotification });

    const init = await duringSetup(
      conn.request<{ protocolVersion?: number; agentInfo?: { name?: string; version?: string } }>("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
        clientInfo: { name: "review-bot", version: BOT_VERSION },
      }),
    );
    if (init === "stopped") return finishStopped();
    if (init?.protocolVersion !== ACP_PROTOCOL_VERSION) {
      return fail("config", `ACP agent "${agentName}" speaks protocol version ${init?.protocolVersion}, not ${ACP_PROTOCOL_VERSION}`);
    }
    result.harness.version = init.agentInfo?.version ?? "unknown";
    result.harness.extensions = [`acp:${init.agentInfo?.name ?? agentName}`];

    const session = await duringSetup(
      conn.request<{ sessionId: string; models?: { currentModelId?: string } }>("session/new", { cwd: ws, mcpServers: [] }),
    );
    if (session === "stopped") return finishStopped();
    sessionId = session.sessionId;
    let modelId = session.models?.currentModelId;
    if (agent.model !== undefined) {
      const set = await duringSetup(conn.request("session/set_model", { sessionId, modelId: agent.model }));
      if (set === "stopped") return finishStopped();
      modelId = agent.model;
    }
    result.servedModels = [modelId ?? `${ACP_PROVIDER}/${agentName}`];

    const accepted = (): number => result.outputs.length;
    let text = composePrompt(request, ws);
    for (let correction = 0; ; correction++) {
      roundText = "";
      countTurn();
      if (stoppedBy !== undefined) break;
      rounds++;
      const response = await untilStopped(
        conn.request<{ stopReason?: string; usage?: PromptUsage }>("session/prompt", { sessionId, prompt: [{ type: "text", text }] }),
      );
      if (response === "stopped") break;
      if (response.usage !== undefined) {
        usageRounds++;
        result.usage.input += num(response.usage.inputTokens);
        result.usage.output += num(response.usage.outputTokens);
        result.usage.cacheRead += num(response.usage.cachedReadTokens);
        result.usage.cacheWrite += num(response.usage.cachedWriteTokens);
        if (response.usage.thoughtTokens !== undefined) result.usage.reasoning = (result.usage.reasoning ?? 0) + num(response.usage.thoughtTokens);
      }
      progress();
      if (stoppedBy !== undefined) break;
      switch (response.stopReason) {
        case "end_turn":
          break;
        case "max_tokens":
          result.outcome = "truncated";
          result.stoppedBy = "output-length";
          break;
        case "max_turn_requests":
          result.outcome = "truncated";
          result.stoppedBy = "turns";
          break;
        case "refusal":
          return fail("provider", `ACP agent "${agentName}" refused the prompt`);
        case "cancelled":
          return fail("internal", "ACP agent cancelled the prompt outside the step's control");
        default:
          return fail("internal", `ACP agent ended the prompt with an unknown stop reason: ${response.stopReason}`);
      }
      if (result.outcome === "truncated") break;

      const parsed = extractCalls(roundText);
      const problems: string[] = [];
      if ("error" in parsed) {
        problems.push(parsed.error);
        result.rejectedCalls.push({ toolCallId: `acp-output-${++rejectionSeq}`, tool: "outputs", kind: "schema", reason: parsed.error });
        result.toolCalls.failed++;
      } else {
        for (const call of parsed.calls) {
          result.toolCalls.total++;
          const checked = checkCall(call, outputTools);
          if (checked.ok) {
            result.outputs.push({ tool: checked.tool, value: checked.value } as ToolOutput<T>);
          } else {
            result.toolCalls.failed++;
            result.rejectedCalls.push({ toolCallId: `acp-output-${++rejectionSeq}`, ...checked.rejection });
            problems.push(`${call.tool}: ${checked.rejection.reason}`);
          }
        }
      }
      if (problems.length === 0 || correction >= (options.maxCorrections ?? 1)) break;
      text = `Some of your outputs were rejected (${accepted()} accepted and recorded):\n${problems.map((p) => `- ${p}`).join("\n")}\n\nReply with a json block containing only the corrected calls, in the same format as before. Do not repeat accepted calls.`;
    }
  } catch (e) {
    if (e instanceof AgentExitedError) return fail(e.startFailed ? "config" : "provider", e.message);
    if (e instanceof RpcError) {
      if (e.code === AUTH_REQUIRED) return fail("config", `ACP agent "${agentName}" needs authentication: log it in outside review-bot (${e.message})`);
      return fail("provider", `ACP agent "${agentName}": ${e.message}`);
    }
    return fail("internal", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timeout);
    clearTimeout(idleTimer);
    request.signal?.removeEventListener("abort", onCancel);
    result.toolCalls.failed += failedToolCalls.size;
    result.usage.turns = turns;
    // Complete only when the agent reported tokens for every round and a cost.
    result.usage.usageComplete = settled && stoppedBy === undefined && rounds > 0 && usageRounds === rounds && costReported;
    await conn?.close();
    // Removes the links only; rm never follows them into the roots.
    rmSync(ws, { recursive: true, force: true });
  }
  if (stoppedBy !== undefined) return finishStopped();
  return finish();

  function finishStopped(): AgentStepResult<T> {
    result.stoppedBy = stoppedBy!;
    result.outcome =
      stoppedBy === "cancelled"
        ? "cancelled"
        : stoppedBy === "timeout" || stoppedBy === "idle" || stoppedBy === "deadline"
          ? "timeout"
          : "truncated";
    if (!settled) {
      result.abandoned = true;
      result.error = { kind: "internal", message: "ACP agent did not settle after cancel" };
    }
    return finish();
  }
}
