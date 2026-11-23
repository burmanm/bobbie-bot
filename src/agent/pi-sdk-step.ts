/**
 * `AgentStep` on the pi SDK (F-3, D-2): one short-lived `createAgentSession`
 * per step, isolated as C-3a requires, with our extension passed in-process
 * (Q-15). Its working directory is an empty directory of the step's own,
 * never the snapshot (D-15, D-19). Limits are enforced by counting events
 * and calling `session.abort()`; pi has no turn cap, step timeout or spend
 * cap.
 *
 * The operator's pi packages (F-7, R-1a step 4b) load into every session:
 * exactly the listed ones, checked offline and resolved outside the read
 * roots (`modules.ts`), before our extension, so a module tool with one of
 * the bot's names replaces it while our guard still runs last.
 *
 * The provider API key comes from the environment only (C-5). This module
 * never reads, stores or logs it.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type Extension,
  type LoadExtensionsResult,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION as PI_VERSION,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  AllowedRoots,
  createReviewExtension,
  EXTENSION_NAME,
  findExecutable,
  type GuardRejection,
  type OutputDetails,
  READ_TOOLS,
  RG_MISSING,
  type QueryTool,
} from "../../pi-review/extension/index.ts";
import { requireExplicitBareRepository } from "../core/git-env.ts";
import { StepAccounting } from "./accounting.ts";
import { createModelRuntime, ModelsFileError } from "./model-runtime.ts";
import { stopReasonOf } from "./limits.ts";
import { ModulesConfigError, type ResolvedModules, resolveModules } from "./modules.ts";
import { summarizeProviderRequest } from "./request-summary.ts";
import type {
  AgentStep,
  AgentStepRequest,
  AgentStepResult,
  ModuleTool,
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
  /**
   * The operator's agent directory (F-7): its `models.json` adds providers,
   * endpoints and model overrides. Absent: pi's built-in catalog only.
   */
  agentDir?: string;
  /**
   * `packages` from the agent directory's settings.json (F-7): loaded into
   * every session, as `review-bot setup` installed them. Needs `agentDir`.
   * When given, empty included, the agent directory is checked as C-3a
   * requires (no AGENTS.md, SYSTEM.md or APPEND_SYSTEM.md).
   */
  packages?: readonly unknown[];
}

const DEFAULT_RETRY = { enabled: true, maxRetries: 2, baseDelayMs: 1000 };
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OUR_EXTENSION = `<inline:${EXTENSION_NAME}>`;

/** A `.git` entry, or a context file pi would pick up walking to the filesystem root (C-3a). */
const FORBIDDEN_ABOVE_CWD = [".git", "AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

/**
 * Where the step may create its directories: the temporary directory, as
 * long as it is outside every read root and has no `.git` entry or context
 * file in it or above it (C-3a). Checked before anything is created there.
 */
function safeTempDir(roots: AllowedRoots): string {
  const dir = realpathSync(tmpdir());
  if (roots.contains(dir)) {
    throw new ConfigError(`the temporary directory ${dir} is inside a read root (C-3a); set TMPDIR to another directory`);
  }
  for (let current = dir; ; current = dirname(current)) {
    for (const name of FORBIDDEN_ABOVE_CWD) {
      if (existsSync(join(current, name))) {
        throw new ConfigError(
          `the temporary directory ${dir} is not isolated: ${join(current, name)} exists (C-3a); set TMPDIR to a directory with no .git or context files above it`,
        );
      }
    }
    if (current === dirname(current)) return dir;
  }
}

/** Re-exported: the entry points set it too, before any step (R-1a step 3). */
export { requireExplicitBareRepository };

/** git's `safe.bareRepository=explicit` (C-3a), a bad `GIT_CONFIG_COUNT` being a configuration error. */
function requireExplicitBareRepositoryOrConfigError(env: NodeJS.ProcessEnv): void {
  try {
    requireExplicitBareRepository(env);
  } catch (e) {
    throw new ConfigError(e instanceof Error ? e.message : String(e));
  }
}

let processAgentDir: string | undefined;

/**
 * Process-wide environment (C-3a), inherited by whatever the process spawns.
 * pi reads its part at call time, so it is set before every step:
 * - `PI_OFFLINE=1`: no catalog refresh, no download of `rg`/`fd`.
 * - `PI_CODING_AGENT_DIR`: a private, empty directory, so any pi code path
 *   that falls back to the default agent directory never reaches
 *   `~/.pi/agent` (extensions, auth.json, settings, AGENTS.md). Each step
 *   also gets its own agent directory, passed explicitly.
 * - git's `safe.bareRepository=explicit`.
 */
function preparePiEnvironment(temp: string): void {
  requireExplicitBareRepositoryOrConfigError(process.env);
  if (processAgentDir === undefined) {
    processAgentDir = mkdtempSync(join(temp, "review-bot-pi-"));
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
  for (const t of [...request.outputTools, ...(request.queryTools ?? [])]) {
    // Plain names only: `tools` on the session also accepts patterns and +/- edits.
    if (!TOOL_NAME.test(t.name)) throw new ConfigError(`invalid output tool name: ${t.name}`);
    if (names.has(t.name)) throw new ConfigError(`duplicate tool name: ${t.name}`);
    names.add(t.name);
  }
  for (const name of request.moduleTools ?? []) {
    if (!TOOL_NAME.test(name)) throw new ConfigError(`invalid tool name: ${name}`);
    if (names.has(name)) throw new ConfigError(`duplicate tool name: ${name}`);
    names.add(name);
  }
  if (options.packages !== undefined && options.agentDir === undefined) {
    throw new ConfigError("packages need the agent directory they are installed in");
  }
  const needsRg = request.readTools.includes("grep") || request.readTools.includes("find");
  if (needsRg && (options.rgPath ?? findExecutable("rg")) === undefined) throw new ConfigError(RG_MISSING);
}

function composeSystemPrompt(request: AgentStepRequest<OutputTool>): string {
  const { head, base, modcache, inputs } = request.roots;
  const lines = [`head: ${head} (relative paths, and omitted ones, resolve here)`];
  if (base !== undefined) lines.push(`base: ${base}`);
  if (modcache !== undefined) lines.push(`modcache: ${modcache}`);
  if (inputs !== undefined) lines.push(`inputs: ${inputs} (review inputs prepared for you, not part of the repository)`);
  return `${request.systemPrompt}\n\n<read_roots>\nThe read tools (read, ls, grep, find) can reach only these directories. Give paths in head relative to head, and use absolute paths for any other root.\n${lines.join("\n")}\n</read_roots>`;
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
    providerRequests: [],
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
    result.stoppedBy = stopReasonOf(request.signal);
    result.outcome = result.stoppedBy === "deadline" ? "timeout" : "cancelled";
    return finish();
  }

  let agentDir: string | undefined;
  let cwd: string | undefined;
  let session: AgentSession | undefined;
  try {
    validateRequest(request, options);
    const roots = new AllowedRoots(rootList(request));
    const temp = safeTempDir(roots);
    preparePiEnvironment(temp);
    agentDir = mkdtempSync(join(temp, "review-bot-agent-"));
    // C-3a, D-15: empty and the step's own, so neither a module nor a program
    // it starts finds configuration from the PR in its working directory.
    cwd = mkdtempSync(join(temp, "review-bot-cwd-"));

    // F-7: the listed packages, checked before anything is loaded.
    const modules: ResolvedModules =
      options.packages === undefined || options.agentDir === undefined
        ? { packages: [], extensions: [] }
        : await resolveModules({ agentDir: options.agentDir, packages: options.packages }, roots, cwd);
    if (options.packages !== undefined) result.harness.packages = modules.packages;

    // Model runtime (F-7, C-3a): pi's catalog and the operator's models.json;
    // credentials and catalog cache in memory; the API key comes from the
    // environment or models.json.
    const modelRuntime = await createModelRuntime({
      ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
      ...(options.providers === undefined ? {} : { providers: options.providers }),
    });

    const guardRejections = new Map<string, GuardRejection>();
    const replacedPathTools = new Set<string>();
    const extension = createReviewExtension({
      roots: roots.roots,
      readTools: request.readTools,
      outputTools: request.outputTools,
      ...(request.queryTools === undefined ? {} : { queryTools: request.queryTools }),
      ...(request.moduleTools === undefined ? {} : { moduleTools: request.moduleTools }),
      replaced: () => replacedPathTools,
      ...(options.rgPath === undefined ? {} : { rgPath: options.rgPath }),
      onReject: (r) => guardRejections.set(r.toolCallId, r),
      onProviderRequest: (payload) => {
        const previous = [...result.providerRequests].reverse().find((r) => r.toolNames !== undefined)?.toolNames;
        result.providerRequests.push(summarizeProviderRequest(payload, previous));
      },
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
      cwd,
      agentDir,
      settingsManager,
      // Nothing discovered. The packages' entry points are passed as paths
      // and load before our extension (F-7).
      noExtensions: true,
      additionalExtensionPaths: modules.extensions.map((e) => e.path),
      extensionFactories: [{ name: EXTENSION_NAME, factory: extension }],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      // F-7: skills and prompt templates are not discovered into model
      // steps, also not those a module adds at session start.
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
      promptsOverride: () => ({ prompts: [], diagnostics: [] }),
      themesOverride: () => ({ themes: [], diagnostics: [] }),
      // AGENTS.md / CLAUDE.md: a separate switch from project trust, and pi
      // walks from cwd to the filesystem root.
      noContextFiles: true,
      systemPrompt: composeSystemPrompt(request),
      appendSystemPrompt: [],
    });
    await resourceLoader.reload();

    const allowlist = [
      ...new Set<string>([
        ...request.readTools,
        ...request.outputTools.map((t) => t.name),
        ...(request.queryTools ?? []).map((t) => t.name),
        ...(request.moduleTools ?? []),
      ]),
    ];
    const loaded = inspectLoaded(resourceLoader.getExtensions(), modules, roots, new Set(allowlist));

    // Providers a module registers are known to pi only once the session
    // binds; the model is chosen before that, so they are registered here
    // too (the session registers them again, unchanged).
    const moduleProviders = new Set<string>();
    for (const { name, config } of loaded.runtime.pendingProviderRegistrations) {
      modelRuntime.registerProvider(name, config as Parameters<ModelRuntime["registerProvider"]>[1]);
      moduleProviders.add(name);
    }
    for (const { provider } of loaded.runtime.pendingNativeProviderRegistrations) {
      modelRuntime.registerNativeProvider(provider);
      moduleProviders.add(provider.id);
    }

    const ownProviders = new Set<string>([...(options.providers ?? []).map((p) => p.id), ...moduleProviders]);
    let model = modelRuntime.getModel(request.model.provider, request.model.id);
    if (model === undefined) {
      // C-6: models change faster than pi's offline catalog. Like pi's own CLI
      // ("Using custom model id"), take the provider's transport settings from
      // one of its catalogued models and use the requested id. The borrowed
      // price table is zeroed so no estimate is made from another model's
      // prices; a provider that bills (OpenRouter) still reports real cost.
      // A wrong id then fails at the provider, as a provider error.
      const template = modelRuntime.getModels(request.model.provider)[0];
      if (template === undefined) throw new ConfigError(`unknown provider "${request.model.provider}"`);
      model = {
        ...template,
        id: request.model.id,
        name: request.model.id,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      } as typeof template;
      result.uncataloguedModel = true;
    }
    if (request.model.routing !== undefined) {
      if (request.model.provider !== "openrouter") {
        throw new ConfigError(`routing preferences are supported only for openrouter, not "${request.model.provider}"`);
      }
      const compat = (model as { compat?: Record<string, unknown> }).compat ?? {};
      model = { ...model, compat: { ...compat, openRouterRouting: request.model.routing } } as typeof model;
    }
    // A module's provider brings its own authentication; a missing key fails at the provider.
    if (!ownProviders.has(request.model.provider) && !modelRuntime.getProviderAuthStatus(request.model.provider).configured) {
      throw new ConfigError(`no credentials for provider "${request.model.provider}"; set its API key in the environment`);
    }

    const created = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model,
      thinkingLevel: request.model.thinkingLevel ?? "off",
      tools: allowlist,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      resourceLoader,
    });
    session = created.session;
    // Isolation invariant (C-3a), checked before extensions get session_start:
    // the directory the session and its extensions work in is ours.
    for (const live of [session.sessionManager.getCwd(), session.extensionRunner.createContext().cwd]) {
      if (live !== cwd || roots.contains(realpathSync(live))) {
        return fail("internal", `isolation: the working directory ${live} is not the step's own directory outside the read roots`);
      }
    }
    for (const name of loaded.replaced) if ((READ_TOOLS as readonly string[]).includes(name)) replacedPathTools.add(name);
    await session.bindExtensions({ mode: "json" });

    result.harness.extensions = created.extensionsResult.extensions.map((e) => e.path);
    result.harness.tools = session.getActiveToolNames();
    if (created.extensionsResult.errors.length > loaded.toleratedErrors) {
      return fail("internal", `extension failed to load: ${created.extensionsResult.errors.map((e) => e.error).join("; ")}`);
    }
    const moduleTools: ModuleTool[] = result.harness.tools.flatMap((tool) => {
      const source = loaded.moduleOwner.get(tool);
      return source === undefined ? [] : [{ tool, source, replaces: loaded.replaced.has(tool) }];
    });
    if (options.packages !== undefined) result.harness.moduleTools = moduleTools;
    // Isolation invariants (C-3a, F-7), checked on the live session before
    // any model call. Several options overlap, so losing one would not show
    // in what the model sees; it is caught here instead.
    if (session.settingsManager.isProjectTrusted()) {
      return fail("internal", "isolation: the session trusts the project");
    }
    const expected = [...modules.extensions.map((e) => e.path), OUR_EXTENSION];
    const live = created.extensionsResult.extensions.map((e) => (e.path === OUR_EXTENSION ? e.path : realpathSync(e.resolvedPath)));
    if (live.join("\n") !== expected.join("\n")) {
      return fail("internal", `isolation: unexpected extensions loaded: ${result.harness.extensions.join(", ")}`);
    }
    if ([...result.harness.tools].sort().join(",") !== [...allowlist].sort().join(",")) {
      return fail("internal", `isolation: active tools ${result.harness.tools.join(",")} differ from the allowlist ${allowlist.join(",")}`);
    }
    if (resourceLoader.getSkills().skills.length > 0 || resourceLoader.getPrompts().prompts.length > 0) {
      return fail("internal", "isolation: a skill or prompt template was loaded into the step (F-7)");
    }

    await drive(session, request, options, result, guardRejections);
    return finish();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const config = error instanceof ConfigError || error instanceof ModelsFileError || error instanceof ModulesConfigError || /^read root/.test(message);
    return fail(config ? "config" : "internal", message);
  } finally {
    session?.dispose();
    for (const dir of [agentDir, cwd]) {
      if (dir === undefined) continue;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // `run` never throws (types.ts). What a tool made unremovable is left in the temporary directory.
      }
    }
  }
}

interface LoadedExtensions {
  runtime: LoadExtensionsResult["runtime"];
  /** The bot's tools that a module registered first, and so replaced. */
  replaced: ReadonlySet<string>;
  /** Tool name -> source of the package whose registration pi uses, for module tools. */
  moduleOwner: ReadonlyMap<string, string>;
  /** Load errors that are only pi reporting a replacement. */
  toleratedErrors: number;
}

/**
 * What the loaded extensions register (F-7). pi keeps the first registration
 * of a tool name and reports each later one as an error, our extension's
 * included. Only those are tolerated: anything else a module reports is a
 * configuration error, and a configured tool that nothing registers is too.
 */
function inspectLoaded(
  result: LoadExtensionsResult,
  modules: ResolvedModules,
  roots: AllowedRoots,
  allowlist: ReadonlySet<string>,
): LoadedExtensions {
  const sourceOf = new Map(modules.extensions.map((e) => [e.path, e.source]));
  const describe = (ext: Extension) => (ext.path === OUR_EXTENSION ? "the bot" : JSON.stringify(sourceOf.get(realpathSync(ext.resolvedPath)) ?? ext.path));
  for (const ext of result.extensions) {
    if (ext.path === OUR_EXTENSION) continue;
    const real = realpathSync(ext.resolvedPath);
    if (!sourceOf.has(real) || roots.contains(real)) throw new Error(`isolation: unexpected extension ${ext.path} (F-7)`);
  }
  const owner = new Map<string, Extension>();
  const tolerated = new Set<string>();
  const replaced = new Set<string>();
  for (const ext of result.extensions) {
    for (const [kind, names] of [["Tool", ext.tools.keys()], ["Flag", ext.flags.keys()]] as const) {
      for (const name of names) {
        const key = `${kind}:${name}`;
        const first = owner.get(key);
        if (first === undefined) {
          owner.set(key, ext);
          continue;
        }
        tolerated.add(`${ext.path}\0${kind === "Tool" ? `Tool "${name}"` : `Flag "--${name}"`} conflicts with ${first.path}`);
        if (kind !== "Tool") continue;
        if (ext.path === OUR_EXTENSION) replaced.add(name);
        else if (allowlist.has(name)) {
          throw new ConfigError(`packages ${describe(first)} and ${describe(ext)} both register the tool "${name}" (F-7)`);
        }
      }
    }
  }
  const errors = result.errors.filter((e) => !tolerated.has(`${e.path}\0${e.error}`));
  if (errors.length > 0) {
    throw new ConfigError(`a package failed to load: ${errors.map((e) => `${e.path}: ${e.error}`).join("; ")}`);
  }
  const missing = [...allowlist].filter((name) => !owner.has(`Tool:${name}`));
  if (missing.length > 0) {
    throw new ConfigError(`the role's tools ${missing.join(", ")} are provided neither by the bot nor by a listed package (F-7)`);
  }
  const moduleOwner = new Map<string, string>();
  for (const [key, ext] of owner) {
    if (key.startsWith("Tool:") && ext.path !== OUR_EXTENSION) moduleOwner.set(key.slice(5), sourceOf.get(realpathSync(ext.resolvedPath))!);
  }
  return { runtime: result.runtime, replaced, moduleOwner, toleratedErrors: result.errors.length - errors.length };
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
  const queryTools = new Map<string, QueryTool>((request.queryTools ?? []).map((t) => [t.name, t]));
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
          } else if (queryTools.has(event.toolName) && reason.startsWith("Validation failed")) {
            // Other query failures (not found, timed out) are answers, not rejections.
            recordRejection({ toolCallId: event.toolCallId, tool: event.toolName, kind: "schema", reason });
          }
        } else {
          const tool = outputTools.get(event.toolName);
          if (tool !== undefined) {
            const value = (event.result?.details as OutputDetails | undefined)?.output;
            // pi validated already; this is defence in depth (S-5), and the
            // only check when a module replaced the output tool (F-7).
            if (Value.Check(tool.parameters, value) && tool.validate?.(value as never) === undefined) {
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
  const onCancel = () => stop(stopReasonOf(request.signal));
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
      stoppedBy === "cancelled"
        ? "cancelled"
        : stoppedBy === "timeout" || stoppedBy === "idle" || stoppedBy === "deadline"
          ? "timeout"
          : "truncated";
    if (!settledInGrace) {
      result.abandoned = true;
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
