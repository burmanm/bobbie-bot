/**
 * `AgentStep` on the pi SDK (F-3, D-2): one short-lived `createAgentSession`
 * per step, isolated as C-3a requires, with our extension passed in-process
 * (Q-15). Limits are enforced by counting events and calling
 * `session.abort()`; pi has no turn cap, step timeout or spend cap.
 *
 * The provider API key comes from the environment only (C-5). This module
 * never reads, stores or logs it.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION as PI_VERSION,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  createReviewExtension,
  EXTENSION_NAME,
  findExecutable,
  type GuardRejection,
  type OutputDetails,
  READ_TOOLS,
  RG_MISSING,
} from "../../pi-review/extension/index.ts";
import { StepAccounting } from "./accounting.ts";
import type {
  AgentStep,
  AgentStepRequest,
  AgentStepResult,
  OutputTool,
  RejectedCall,
  StoppedBy,
  ToolOutput,
} from "./types.ts";

type NativeProvider = Parameters<ModelRuntime["registerNativeProvider"]>[0];

export interface PiSdkAgentStepOptions {
  /**
   * Extra model providers registered on every step's model runtime. Tests
   * pass pi's scripted ("faux") provider here. Providers given here are not
   * checked for credentials.
   */
  providers?: readonly NativeProvider[];
  /** Path to `rg`. Default: looked up on PATH. Never downloaded. */
  rgPath?: string;
  /** pi's automatic retry of transient provider errors. */
  retry?: { enabled: boolean; maxRetries?: number; baseDelayMs?: number };
  /** How long to wait for pi to settle after an abort before giving up on it. */
  abortGraceMs?: number;
}

const DEFAULT_RETRY = { enabled: true, maxRetries: 2, baseDelayMs: 1000 };
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

let processAgentDir: string | undefined;

/**
 * Process-wide pi environment (C-3a). Read by pi at call time, so it is set
 * before every step:
 * - `PI_OFFLINE=1`: no catalog refresh, no download of `rg`/`fd`.
 * - `PI_CODING_AGENT_DIR`: a private, empty directory, so any pi code path
 *   that falls back to the default agent directory never reaches
 *   `~/.pi/agent` (extensions, auth.json, settings, AGENTS.md). Each step
 *   also gets its own agent directory, passed explicitly.
 */
function preparePiEnvironment(): void {
  if (processAgentDir === undefined) {
    processAgentDir = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-pi-")));
  }
  process.env.PI_CODING_AGENT_DIR = processAgentDir;
  process.env.PI_OFFLINE = "1";
  process.env.PI_SKIP_VERSION_CHECK = "1";
  process.env.PI_TELEMETRY = "0";
}

export function createPiSdkAgentStep(options: PiSdkAgentStepOptions = {}): AgentStep {
  return {
    run: (request) => runStep(request, options),
  };
}

/** Thrown for a request that cannot run; becomes an `error` outcome of kind `config`. */
class ConfigError extends Error {}

function rootList(request: AgentStepRequest<OutputTool>): string[] {
  const { head, base, modcache, inputs } = request.roots;
  return [head, ...[base, modcache, inputs].filter((r): r is string => r !== undefined)];
}

function validateRequest(request: AgentStepRequest<OutputTool>, options: PiSdkAgentStepOptions): void {
  const { limits } = request;
  if (!(limits.maxTurns >= 1)) throw new ConfigError("limits.maxTurns must be at least 1");
  if (!(limits.timeoutMs > 0)) throw new ConfigError("limits.timeoutMs must be positive");
  if (limits.idleTimeoutMs !== undefined && !(limits.idleTimeoutMs > 0)) {
    throw new ConfigError("limits.idleTimeoutMs must be positive");
  }
  for (const t of request.readTools) {
    if (!(READ_TOOLS as readonly string[]).includes(t)) throw new ConfigError(`unknown read tool: ${t}`);
  }
  const names = new Set<string>(request.readTools);
  for (const t of request.outputTools) {
    // Plain names only: `tools` on the session also accepts patterns and +/- edits.
    if (!TOOL_NAME.test(t.name)) throw new ConfigError(`invalid output tool name: ${t.name}`);
    if (names.has(t.name)) throw new ConfigError(`duplicate tool name: ${t.name}`);
    names.add(t.name);
  }
  const needsRg = request.readTools.includes("grep") || request.readTools.includes("find");
  if (needsRg && (options.rgPath ?? findExecutable("rg")) === undefined) throw new ConfigError(RG_MISSING);
}

function composeSystemPrompt(request: AgentStepRequest<OutputTool>): string {
  const { head, base, modcache, inputs } = request.roots;
  const lines = [`head: ${head} (working directory; relative paths resolve here)`];
  if (base !== undefined) lines.push(`base: ${base}`);
  if (modcache !== undefined) lines.push(`modcache: ${modcache}`);
  if (inputs !== undefined) lines.push(`inputs: ${inputs} (review inputs prepared for you, not part of the repository)`);
  return `${request.systemPrompt}\n\n<read_roots>\nThe read tools can reach only these directories. Use absolute paths for any root other than head.\n${lines.join("\n")}\n</read_roots>`;
}

function emptyResult<T extends OutputTool>(): AgentStepResult<T> {
  return {
    outcome: "ok",
    outputs: [],
    rejectedCalls: [],
    toolCalls: { total: 0, failed: 0 },
    usage: {
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
      costIsBilled: false,
      usageComplete: true,
      wallMs: 0,
    },
    servedModels: [],
    harness: { name: "pi-sdk", version: PI_VERSION, extensions: [], tools: [] },
  };
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: unknown }> } | undefined)?.content ?? [];
  return content.map((c) => (typeof c.text === "string" ? c.text : "")).join("");
}

async function runStep<T extends OutputTool>(
  request: AgentStepRequest<T>,
  options: PiSdkAgentStepOptions,
): Promise<AgentStepResult<T>> {
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
    result.outcome = "cancelled";
    result.stoppedBy = "cancelled";
    return finish();
  }

  let agentDir: string | undefined;
  let session: AgentSession | undefined;
  try {
    validateRequest(request, options);
    preparePiEnvironment();
    agentDir = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-agent-")));

    // Model runtime: credentials file in the private, empty agent dir;
    // models.json not read; the API key comes from the environment.
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null });
    const ownProviders = new Set<string>();
    for (const provider of options.providers ?? []) {
      modelRuntime.registerNativeProvider(provider);
      ownProviders.add(provider.id);
    }
    let model = modelRuntime.getModel(request.model.provider, request.model.id);
    if (model === undefined) {
      throw new ConfigError(`unknown model "${request.model.id}" for provider "${request.model.provider}"`);
    }
    if (request.model.routing !== undefined) {
      if (request.model.provider !== "openrouter") {
        throw new ConfigError(`routing preferences are supported only for openrouter, not "${request.model.provider}"`);
      }
      const compat = (model as { compat?: Record<string, unknown> }).compat ?? {};
      model = { ...model, compat: { ...compat, openRouterRouting: request.model.routing } } as typeof model;
    }
    if (!ownProviders.has(request.model.provider) && !modelRuntime.getProviderAuthStatus(request.model.provider).configured) {
      throw new ConfigError(`no credentials for provider "${request.model.provider}"; set its API key in the environment`);
    }

    const roots = rootList(request);
    const head = realpathSync(request.roots.head);
    const guardRejections = new Map<string, GuardRejection>();
    const extension = createReviewExtension({
      roots,
      readTools: request.readTools,
      outputTools: request.outputTools,
      ...(options.rgPath === undefined ? {} : { rgPath: options.rgPath }),
      onReject: (r) => guardRejections.set(r.toolCallId, r),
    });

    // C-3a: in-memory settings with projectTrusted false keeps the
    // snapshot's .pi/ (settings, extensions, skills, prompts, themes,
    // SYSTEM.md) and the user's settings out. The SDK default trusts the
    // project.
    const settingsManager = SettingsManager.inMemory(
      { compaction: { enabled: false }, retry: options.retry ?? DEFAULT_RETRY },
      { projectTrusted: false },
    );
    const resourceLoader = new DefaultResourceLoader({
      cwd: head,
      agentDir,
      settingsManager,
      noExtensions: true,
      extensionFactories: [{ name: EXTENSION_NAME, factory: extension }],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      // AGENTS.md / CLAUDE.md: a separate switch from project trust, and pi
      // walks from cwd to the filesystem root.
      noContextFiles: true,
      systemPrompt: composeSystemPrompt(request),
      appendSystemPrompt: [],
    });
    await resourceLoader.reload();

    const allowlist = [...new Set<string>([...request.readTools, ...request.outputTools.map((t) => t.name)])];
    const created = await createAgentSession({
      cwd: head,
      agentDir,
      modelRuntime,
      model,
      thinkingLevel: request.model.thinkingLevel ?? "off",
      tools: allowlist,
      sessionManager: SessionManager.inMemory(head),
      settingsManager,
      resourceLoader,
    });
    session = created.session;
    await session.bindExtensions({ mode: "json" });

    result.harness.extensions = created.extensionsResult.extensions.map((e) => e.path);
    result.harness.tools = session.getActiveToolNames();
    if (created.extensionsResult.errors.length > 0) {
      return fail("internal", `extension failed to load: ${created.extensionsResult.errors.map((e) => e.error).join("; ")}`);
    }
    // Isolation invariants (C-3a), checked on the live session before any
    // model call. Several options overlap, so losing one would not show in
    // what the model sees; it is caught here instead.
    if (session.settingsManager.isProjectTrusted()) {
      return fail("internal", "isolation: the session trusts the project");
    }
    if (result.harness.extensions.join(",") !== `<inline:${EXTENSION_NAME}>`) {
      return fail("internal", `isolation: unexpected extensions loaded: ${result.harness.extensions.join(", ")}`);
    }
    if ([...result.harness.tools].sort().join(",") !== [...allowlist].sort().join(",")) {
      return fail("internal", `isolation: active tools ${result.harness.tools.join(",")} differ from the allowlist ${allowlist.join(",")}`);
    }

    await drive(session, request, options, result, guardRejections);
    return finish();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(error instanceof ConfigError || /^read root/.test(message) ? "config" : "internal", message);
  } finally {
    session?.dispose();
    if (agentDir !== undefined) rmSync(agentDir, { recursive: true, force: true });
  }
}

/** Prompt the session, watch its events, enforce the limits, fill `result`. */
async function drive<T extends OutputTool>(
  session: AgentSession,
  request: AgentStepRequest<T>,
  options: PiSdkAgentStepOptions,
  result: AgentStepResult<T>,
  guardRejections: Map<string, GuardRejection>,
): Promise<void> {
  const { limits } = request;
  const accounting = new StepAccounting(limits);
  const outputTools = new Map<string, OutputTool>(request.outputTools.map((t) => [t.name, t]));
  const declared = new Set(result.harness.tools);
  let stoppedBy: StoppedBy | undefined;
  let requestInFlight = false;
  let abortedInFlight = false;
  let lastTool: string | undefined;
  let onStopped: () => void = () => {};
  const stopped = new Promise<void>((resolve) => (onStopped = resolve));

  /** Time limits and cancellation: abort whatever is running. */
  const stop = (reason: StoppedBy) => {
    if (stoppedBy !== undefined) return;
    stoppedBy = reason;
    if (requestInFlight) abortedInFlight = true;
    onStopped();
    void session.abort();
  };

  // Turn and spend caps end the run cleanly between turns, through
  // pi-agent-core's finishTurn hook (the same one pi chains for its own
  // turn_end boundary). Aborting from a turn_end listener instead races
  // the next request and starts one more, aborted, model call.
  const piFinishTurn = session.agent.finishTurn;
  session.agent.finishTurn = async (turn, signal): Promise<{ action: "continue" } | { action: "end" } | undefined> => {
    const decision = (await piFinishTurn?.(turn, signal)) ?? undefined;
    const limit = stoppedBy === undefined ? accounting.limitAfterTurn(turn.toolResults.length > 0) : undefined;
    if (limit === undefined) return decision;
    stoppedBy = limit;
    return { action: "end" };
  };
  const progress = () => {
    request.onProgress?.({ turns: accounting.turns, costUsd: accounting.costUsd, ...(lastTool === undefined ? {} : { lastTool }) });
  };

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => {
    if (limits.idleTimeoutMs === undefined || stoppedBy !== undefined) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop("idle"), limits.idleTimeoutMs);
  };

  const recordRejection = (call: RejectedCall) => result.rejectedCalls.push(call);

  const onEvent = (event: AgentSessionEvent) => {
    resetIdle();
    switch (event.type) {
      case "turn_start":
        requestInFlight = true;
        break;
      case "message_end": {
        const m = event.message as { role?: string };
        if (m.role !== "assistant") break;
        requestInFlight = false;
        accounting.add(event.message as unknown as Parameters<StepAccounting["add"]>[0]);
        progress();
        break;
      }
      case "tool_execution_end": {
        result.toolCalls.total++;
        lastTool = event.toolName;
        const guarded = guardRejections.get(event.toolCallId);
        if (event.isError) {
          result.toolCalls.failed++;
          const reason = textOf(event.result);
          if (guarded !== undefined) {
            recordRejection({ toolCallId: event.toolCallId, tool: event.toolName, kind: "guard", reason: guarded.reason });
          } else if (!declared.has(event.toolName)) {
            recordRejection({ toolCallId: event.toolCallId, tool: event.toolName, kind: "not-allowed", reason });
          } else if (outputTools.has(event.toolName)) {
            const kind = reason.startsWith("Validation failed") ? "schema" : "validator";
            recordRejection({ toolCallId: event.toolCallId, tool: event.toolName, kind, reason });
          }
        } else {
          const tool = outputTools.get(event.toolName);
          if (tool !== undefined) {
            const value = (event.result?.details as OutputDetails | undefined)?.output;
            // pi validated already; this is defence in depth (S-5).
            if (Value.Check(tool.parameters, value)) {
              result.outputs.push({ tool: tool.name, value } as ToolOutput<T>);
            } else {
              result.toolCalls.failed++;
              recordRejection({
                toolCallId: event.toolCallId,
                tool: event.toolName,
                kind: "schema",
                reason: "output failed re-validation",
              });
            }
          }
        }
        progress();
        break;
      }
    }
  };

  const unsubscribe = session.subscribe(onEvent);
  const timeout = setTimeout(() => stop("timeout"), limits.timeoutMs);
  const onCancel = () => stop("cancelled");
  request.signal?.addEventListener("abort", onCancel, { once: true });
  resetIdle();

  let promptError: string | undefined;
  let settledInGrace = true;
  try {
    const prompting = session.prompt(request.prompt, { expandPromptTemplates: false }).then(
      () => "done" as const,
      (e: unknown) => {
        promptError = e instanceof Error ? e.message : String(e);
        return "done" as const;
      },
    );
    // After an abort pi normally settles at once; do not hang if it does not.
    const grace = stopped.then(
      () => new Promise<"grace">((resolve) => setTimeout(() => resolve("grace"), options.abortGraceMs ?? 10_000).unref()),
    );
    settledInGrace = (await Promise.race([prompting, grace])) === "done";
  } finally {
    clearTimeout(timeout);
    clearTimeout(idleTimer);
    request.signal?.removeEventListener("abort", onCancel);
    if (piFinishTurn === undefined) delete session.agent.finishTurn;
    else session.agent.finishTurn = piFinishTurn;
    unsubscribe();
  }

  const last = accounting.last;
  result.usage = {
    ...result.usage,
    turns: accounting.turns,
    input: accounting.input,
    output: accounting.output,
    cacheRead: accounting.cacheRead,
    cacheWrite: accounting.cacheWrite,
    ...(accounting.reasoning === undefined ? {} : { reasoning: accounting.reasoning }),
    costUsd: accounting.costUsd,
    costIsBilled: accounting.costIsBilled,
    usageComplete: !abortedInFlight && accounting.abortedCalls === 0 && settledInGrace,
  };
  result.servedModels = [...accounting.servedModels];

  if (stoppedBy !== undefined) {
    result.stoppedBy = stoppedBy;
    result.outcome =
      stoppedBy === "cancelled" ? "cancelled" : stoppedBy === "timeout" || stoppedBy === "idle" ? "timeout" : "truncated";
    if (!settledInGrace) {
      result.error = { kind: "internal", message: "pi did not settle after abort" };
    }
    return;
  }
  if (promptError !== undefined) {
    result.outcome = "error";
    result.error = { kind: "internal", message: promptError };
    return;
  }
  const lastMessage = last as { stopReason?: string; errorMessage?: string } | undefined;
  if (lastMessage?.stopReason === "error") {
    result.outcome = "error";
    result.error = { kind: "provider", message: lastMessage.errorMessage ?? "model call failed" };
  } else if (lastMessage?.stopReason === "aborted") {
    result.outcome = "error";
    result.error = { kind: "internal", message: "model call aborted outside the step's control" };
  } else if (lastMessage?.stopReason === "length") {
    result.outcome = "truncated";
    result.stoppedBy = "output-length";
  } else if (last === undefined) {
    result.outcome = "error";
    result.error = { kind: "internal", message: "no model call was made" };
  }
}
