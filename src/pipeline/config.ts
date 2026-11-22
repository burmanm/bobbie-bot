/**
 * Bot configuration (F-7, A-5, C-2, P-4). Precedence:
 *
 * 1. the built-in limits and skip rules below;
 * 2. `reviewBot` in the operator's `settings.json` (agent-settings.ts);
 * 3. workflow inputs (CLI flags here): both 2 and 3 are the maintainers';
 * 4. `.review/review-bot.yaml` from the base branch, which need not be the
 *    default branch and so can only narrow what 1-3 allow (C-3, D-19).
 *
 * What the YAML may do:
 *
 * | Key | Rule |
 * |---|---|
 * | `limits.*` | Equal or lower, per field. A per-step `maxCostUsd` may be set where there is none |
 * | `limits.chunkPatchLines` | Fixed: only the value in effect. Lower means more steps, each with its own turn and time limits, and higher means more in one step, so neither direction narrows |
 * | `roles.<role>` | A model in `enabledModels`, or the one already configured. Without that list, only the latter |
 * | `skip`, `ci`, `authorization` | The repository's own policy: replace what is above |
 * | anything else (tools, packages, providers, endpoints) | No such key |
 *
 * A refused value is a ConfigError listing every refusal, not a clamp with
 * a warning: the run then completes neutral and names them in the check and
 * the PR comment (S-9), and nothing runs under settings other than the ones
 * the repository reads in its file.
 *
 * Every caller passes settings (R-1a step 2b). Without an agent directory
 * they are `NO_AGENT_SETTINGS`: no `enabledModels`, so the YAML cannot change
 * a model at all and the run uses the models the inputs name (local dry
 * runs). There is no other path: the YAML's former `thinking`, `providers`
 * and `routing` fields are gone (H-42, H-45).
 *
 * The run timeout input may instead be a ceiling (`runTimeoutCeilingMs`, the
 * action's job limit): applied last, it lowers whatever 1-4 chose and is
 * never refused, so a lower value in settings or the YAML takes effect.
 *
 * There is **no default model** anywhere in code: a role without a model is
 * a configuration error for `reviewer`, and turns adversarial verification
 * off for `verifier` (reported under "Not run"). Limits do have defaults:
 * they are safety, not tuning (P-9).
 *
 * The gate reads this configuration without loading pi (F-7): no static
 * import of pi here.
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { parse as parseYaml } from "yaml";
import type { ModelRef, StepLimits, ThinkingLevel } from "../agent/index.ts";
import {
  type AgentSettings,
  AuthorizationSchema,
  NO_AGENT_SETTINGS,
  CiSchema,
  ConfigError,
  LimitsSchema,
  parseModelSpec,
  PIPELINE_ROLES,
  type PipelineRole,
  quoteValue,
  secondsToMs,
  SkipSchema,
  stepLimitsFromSchema,
} from "./agent-settings.ts";
import { cloneSkipConfig, DEFAULT_SKIP, type SkipConfig } from "./skip.ts";

export { ConfigError, NO_AGENT_SETTINGS, parseDuration, parseModelSpec, PIPELINE_ROLES, type PipelineRole } from "./agent-settings.ts";

export interface PipelineConfig {
  roles: Partial<Record<PipelineRole, ModelRef>>;
  /**
   * Each role's `tools` setting as written (F-7); only settings.json can
   * give one. Resolve with `resolveRoleTools` against the role's default.
   */
  tools: Partial<Record<PipelineRole, string[]>>;
  limits: Record<PipelineRole, StepLimits> & {
    /** Whole-run spend cap (S-4 Limits). */
    runCostUsd: number;
    /**
     * Whole-run deadline, from the start of the run (S-4 Limits, S-9). When
     * it passes, the running step is stopped, no further step starts, and
     * what exists is published labelled partial with a neutral check. Set
     * the CI job's own timeout a few minutes above it, so publishing fits.
     */
    runTimeoutMs: number;
    /** Above this many patch lines the review is chunked by directory (S-4 Phase 1). */
    chunkPatchLines: number;
  };
  /** S-1 skip conditions; see skip.ts. */
  skip: SkipConfig;
}

export const DEFAULT_LIMITS: PipelineConfig["limits"] = {
  reviewer: { timeoutMs: 20 * 60_000, idleTimeoutMs: 3 * 60_000, maxTurns: 120 },
  verifier: { timeoutMs: 8 * 60_000, idleTimeoutMs: 3 * 60_000, maxTurns: 40 },
  runCostUsd: 5,
  runTimeoutMs: 45 * 60_000,
  chunkPatchLines: 4000,
};


export function formatModel(m: Pick<ModelRef, "provider" | "id">): string {
  return `${m.provider}/${m.id}`;
}

/**
 * A role in the YAML: `provider/id[:thinking]`, or `{ model: ... }`. Nothing
 * else: thinking is the suffix, and upstream providers and routing are the
 * operator's `models.json` and inputs (F-7, H-45).
 */
const RoleYaml = Type.Union([
  Type.String({ minLength: 3 }),
  Type.Object({ model: Type.String({ minLength: 3 }) }, { additionalProperties: false }),
]);

/** `.review/review-bot.yaml` (A-5). Bot settings only; never review guidance. */
export const BotConfigYaml = Type.Object(
  {
    roles: Type.Optional(Type.Object({ reviewer: Type.Optional(RoleYaml), verifier: Type.Optional(RoleYaml) }, { additionalProperties: false })),
    limits: Type.Optional(LimitsSchema),
    skip: Type.Optional(SkipSchema),
    /** Used by the gate job only; accepted and ignored by the review run. */
    ci: Type.Optional(CiSchema),
    /** Used by the gate job only; accepted and ignored by the review run. */
    authorization: Type.Optional(AuthorizationSchema),
  },
  { additionalProperties: false },
);
export type BotConfigYaml = Static<typeof BotConfigYaml>;

/** Configuration as given by workflow inputs / CLI flags. */
export interface ConfigInputs {
  /** role → "provider/id". */
  models?: Partial<Record<PipelineRole, string>>;
  thinking?: Partial<Record<PipelineRole, ThinkingLevel>>;
  /** role → OpenRouter provider slugs the model may be served by (routing `only`). */
  providers?: Partial<Record<PipelineRole, string[]>>;
  runCostUsd?: number;
  runTimeoutMs?: number;
  /**
   * The longest the run may take whatever the configuration says: the CI
   * job's own limit (S-9). Lowers the result; a lower value stands.
   */
  runTimeoutCeilingMs?: number;
  chunkPatchLines?: number;
  skipDraft?: boolean;
  /** S-1 skip labels and dependency paths (workflow inputs); each replaces its default. */
  skip?: Partial<Omit<SkipConfig, "draft" | "dependencies">> & { dependencyLabels?: string[]; dependencyPaths?: string[] };
  /** Per-role step limits (workflow inputs). */
  limits?: Partial<Record<PipelineRole, Partial<StepLimits>>>;
}

/** The OpenRouter provider router (C-6) only exists for the openrouter provider. */
export const OPENROUTER = "openrouter";

/**
 * Restrict `ref` to the given OpenRouter providers: routing `only`, with
 * fallbacks to other providers off. Merged into any other routing settings.
 */
export function withProviders(ref: ModelRef, providers: readonly string[], where: string): ModelRef {
  const list = [...new Set(providers.map((p) => p.trim()).filter((p) => p.length > 0))];
  if (list.length === 0) throw new ConfigError(`${where}: the provider list is empty`);
  if (ref.provider !== OPENROUTER) {
    throw new ConfigError(`${where}: a provider list needs an ${OPENROUTER} model, not "${formatModel(ref)}"`);
  }
  if (ref.routing?.only !== undefined) throw new ConfigError(`${where}: give either providers or routing.only, not both`);
  return { ...ref, routing: { ...ref.routing, only: list, allow_fallbacks: false } };
}

export function parseBotConfigYaml(text: string): BotConfigYaml {
  let data: unknown;
  try {
    data = parseYaml(text) ?? {};
  } catch (e) {
    throw new ConfigError(`.review/review-bot.yaml is not valid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Value.Check(BotConfigYaml, data)) {
    const errors = [...Value.Errors(BotConfigYaml, data)].slice(0, 5).map((e) => `${e.instancePath || "/"}: ${e.message}`);
    throw new ConfigError(`.review/review-bot.yaml is invalid: ${errors.join("; ")}`);
  }
  return data;
}

/** A model the repository may pick: one match of `enabledModels` (F-7). */
export interface EnabledModel {
  provider: string;
  id: string;
  /** From the pattern's suffix; used when the YAML's choice has none. */
  thinkingLevel?: ThinkingLevel;
}

/** What `resolveEnabledModels` needs of pi's model runtime. */
export type ModelCatalog = Pick<ModelRuntime, "getAvailable">;

/**
 * `enabledModels` resolved by pi itself, so globs, bare ids, fuzzy matches
 * and suffixes mean what they mean to `pi --models`. Only models pi can use
 * match: a repository cannot pick an id that is in neither pi's catalog nor
 * the operator's `models.json`.
 */
export async function resolveEnabledModels(
  settings: AgentSettings,
  runtime: ModelCatalog,
): Promise<{ models: EnabledModel[]; warnings: string[] }> {
  if (settings.enabledModels.length === 0) return { models: [], warnings: [] };
  const { resolveModelScopeWithDiagnostics } = await import("@earendil-works/pi-coding-agent");
  // pi's function reads nothing of the runtime but getAvailable.
  const scope = await resolveModelScopeWithDiagnostics(settings.enabledModels, runtime as ModelRuntime, {
    signal: AbortSignal.timeout(15_000), // as pi's own start-up does
  });
  const models = scope.scopedModels.map(({ model, thinkingLevel }): EnabledModel => ({
    provider: model.provider,
    id: model.id,
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  }));
  return { models, warnings: scope.diagnostics.map((d) => d.message) };
}

/**
 * The run's configuration, by the precedence at the top of this file.
 *
 * `settings` is the agent directory's, or `NO_AGENT_SETTINGS` without one.
 * `enabled` is what `resolveEnabledModels` returned for them; without it the
 * YAML cannot change a model.
 */
export function resolveConfig(
  inputs: ConfigInputs,
  yamlText: string | undefined,
  settings: AgentSettings,
  enabled: readonly EnabledModel[] = [],
): PipelineConfig {
  const config: PipelineConfig = {
    roles: {},
    tools: {},
    limits: { ...DEFAULT_LIMITS, reviewer: { ...DEFAULT_LIMITS.reviewer }, verifier: { ...DEFAULT_LIMITS.verifier } },
    skip: cloneSkipConfig(DEFAULT_SKIP),
  };
  applySettings(config, settings);
  applyInputs(config, inputs);
  if (yamlText !== undefined) applyYaml(config, parseBotConfigYaml(yamlText), settings, enabled);
  if (inputs.runTimeoutCeilingMs !== undefined) config.limits.runTimeoutMs = Math.min(config.limits.runTimeoutMs, inputs.runTimeoutCeilingMs);
  return config;
}

/**
 * The run deadline before the YAML is read (S-4 Limits): inputs, else
 * settings, else the default; never above the ceiling. The YAML can only
 * lower it, so this is the longest the run can be allowed.
 */
export function initialRunTimeoutMs(inputs: ConfigInputs, settings: AgentSettings = NO_AGENT_SETTINGS): number {
  const seconds = settings.reviewBot.limits?.runTimeoutSeconds;
  const ms = inputs.runTimeoutMs ?? (seconds === undefined ? DEFAULT_LIMITS.runTimeoutMs : secondsToMs(seconds));
  return Math.min(ms, inputs.runTimeoutCeilingMs ?? Infinity);
}

function applySettings(config: PipelineConfig, settings: AgentSettings): void {
  const { roles, limits, skip } = settings.reviewBot;
  for (const role of PIPELINE_ROLES) {
    const r = roles?.[role];
    if (r?.model !== undefined) config.roles[role] = parseModelSpec(r.model);
    if (r?.tools !== undefined) config.tools[role] = [...r.tools];
    config.limits[role] = { ...config.limits[role], ...stepLimitsFromSchema(limits?.[role]) };
  }
  if (limits?.runCostUsd !== undefined) config.limits.runCostUsd = limits.runCostUsd;
  if (limits?.runTimeoutSeconds !== undefined) config.limits.runTimeoutMs = secondsToMs(limits.runTimeoutSeconds);
  if (limits?.chunkPatchLines !== undefined) config.limits.chunkPatchLines = limits.chunkPatchLines;
  applySkip(config.skip, skip);
}

function applySkip(skip: SkipConfig, from: Static<typeof SkipSchema> | undefined): void {
  if (from?.draft !== undefined) skip.draft = from.draft;
  if (from?.labels !== undefined) skip.labels = [...from.labels];
  if (from?.optOutLabels !== undefined) skip.optOutLabels = [...from.optOutLabels];
  if (from?.roundCapLabels !== undefined) skip.roundCapLabels = [...from.roundCapLabels];
  if (from?.dependencies?.labels !== undefined) skip.dependencies.labels = [...from.dependencies.labels];
  if (from?.dependencies?.paths !== undefined) skip.dependencies.paths = [...from.dependencies.paths];
}

function applyInputs(config: PipelineConfig, inputs: ConfigInputs): void {
  for (const role of PIPELINE_ROLES) {
    const spec = inputs.models?.[role];
    // An input model replaces the whole value, thinking suffix included.
    let ref = spec === undefined ? config.roles[role] : parseModelSpec(spec);
    const thinking = inputs.thinking?.[role];
    // As pi's --thinking, which overrides a --model suffix.
    if (ref !== undefined && thinking !== undefined) ref = { ...ref, thinkingLevel: thinking };
    const providers = inputs.providers?.[role];
    if (providers !== undefined) {
      if (ref === undefined) throw new ConfigError(`--providers ${role}: no model is given for the ${role} role`);
      ref = withProviders(ref, providers, `--providers ${role}`);
    }
    if (ref !== undefined) config.roles[role] = ref;
    const l = inputs.limits?.[role];
    if (l !== undefined) config.limits[role] = { ...config.limits[role], ...(l as StepLimits) };
  }
  if (inputs.runCostUsd !== undefined) config.limits.runCostUsd = inputs.runCostUsd;
  if (inputs.runTimeoutMs !== undefined) config.limits.runTimeoutMs = inputs.runTimeoutMs;
  if (inputs.chunkPatchLines !== undefined) config.limits.chunkPatchLines = inputs.chunkPatchLines;
  if (inputs.skipDraft !== undefined) config.skip.draft = inputs.skipDraft;
  const sk = inputs.skip;
  if (sk?.labels !== undefined) config.skip.labels = [...sk.labels];
  if (sk?.optOutLabels !== undefined) config.skip.optOutLabels = [...sk.optOutLabels];
  if (sk?.roundCapLabels !== undefined) config.skip.roundCapLabels = [...sk.roundCapLabels];
  if (sk?.dependencyLabels !== undefined) config.skip.dependencies.labels = [...sk.dependencyLabels];
  if (sk?.dependencyPaths !== undefined) config.skip.dependencies.paths = [...sk.dependencyPaths];
}

/** The base branch's file on top: narrowing only, every refusal reported at once (F-7). */
function applyYaml(config: PipelineConfig, y: BotConfigYaml, settings: AgentSettings, enabled: readonly EnabledModel[]): void {
  const refused: string[] = [];
  narrowLimits(config.limits, y.limits, refused);
  for (const role of PIPELINE_ROLES) {
    const wanted = y.roles?.[role];
    if (wanted === undefined) continue;
    const spec = typeof wanted === "string" ? wanted : wanted.model;
    const allowed = settings.enabledModels.length > 0 ? enabled : [];
    const ref = chooseModel(spec, config.roles[role], allowed);
    if (ref !== undefined) config.roles[role] = ref;
    else {
      const why = settings.enabledModels.length > 0 ? "not in enabledModels" : "no enabledModels, so the model is fixed";
      refused.push(`roles.${role} ${quoteValue(spec)} (${why})`);
    }
  }
  if (refused.length > 0) {
    // Short: the failure comment keeps the first 300 characters (S-9).
    throw new ConfigError(`.review/review-bot.yaml can only narrow the configuration; refused: ${refused.join("; ")}`);
  }
  applySkip(config.skip, y.skip);
}

/** Lower `limits` as the YAML asks; a value that would not narrow is added to `refused`. */
function narrowLimits(limits: PipelineConfig["limits"], y: Static<typeof LimitsSchema> | undefined, refused: string[]): void {
  if (y === undefined) return;
  /** The value to use. `scale` turns the stored unit back into the YAML's. */
  const lower = <T extends number | undefined>(key: string, current: T, asked: number | undefined, scale = 1): T | number => {
    if (asked === undefined) return current;
    if (current === undefined || asked <= current) return asked;
    refused.push(`limits.${key} ${asked / scale} (at most ${current / scale})`);
    return current;
  };
  for (const role of PIPELINE_ROLES) {
    const asked = stepLimitsFromSchema(y[role]);
    const step = limits[role];
    step.timeoutMs = lower(`${role}.timeoutSeconds`, step.timeoutMs, asked.timeoutMs, 1000);
    const idle = lower(`${role}.idleTimeoutSeconds`, step.idleTimeoutMs, asked.idleTimeoutMs, 1000);
    if (idle !== undefined) step.idleTimeoutMs = idle;
    step.maxTurns = lower(`${role}.maxTurns`, step.maxTurns, asked.maxTurns);
    const cost = lower(`${role}.maxCostUsd`, step.maxCostUsd, asked.maxCostUsd);
    if (cost !== undefined) step.maxCostUsd = cost;
  }
  limits.runCostUsd = lower("runCostUsd", limits.runCostUsd, y.runCostUsd);
  const runTimeout = y.runTimeoutSeconds === undefined ? undefined : secondsToMs(y.runTimeoutSeconds);
  limits.runTimeoutMs = lower("runTimeoutSeconds", limits.runTimeoutMs, runTimeout, 1000);
  if (y.chunkPatchLines !== undefined && y.chunkPatchLines !== limits.chunkPatchLines) {
    refused.push(`limits.chunkPatchLines ${y.chunkPatchLines} (fixed at ${limits.chunkPatchLines})`);
  }
}

/**
 * The model for a YAML `spec`, or undefined when it may not be used. No
 * fuzzy match on this side: the YAML names `provider/id` exactly (in any
 * case). As in pi, an id equal to the whole text wins over reading a suffix.
 */
function chooseModel(spec: string, current: ModelRef | undefined, enabled: readonly EnabledModel[]): ModelRef | undefined {
  const text = spec.trim().toLowerCase();
  const named = (m: ModelRef | EnabledModel, name: string) => formatModel(m).toLowerCase() === name;
  // Restating the configured model keeps all of it: thinking and routing too.
  if (current !== undefined && named(current, text)) return current;

  let match = enabled.find((m) => named(m, text));
  let thinkingLevel = match?.thinkingLevel;
  if (match === undefined) {
    const colon = text.lastIndexOf(":");
    let asked: ModelRef;
    try {
      asked = parseModelSpec(spec);
    } catch {
      return undefined;
    }
    if (asked.thinkingLevel === undefined) return undefined;
    const name = text.slice(0, colon);
    if (current !== undefined && named(current, name) && (current.thinkingLevel ?? "off") === asked.thinkingLevel) return current;
    match = enabled.find((m) => named(m, name));
    if (match === undefined) return undefined;
    thinkingLevel = asked.thinkingLevel;
  }
  const ref: ModelRef = { provider: match.provider, id: match.id };
  if (thinkingLevel !== undefined) ref.thinkingLevel = thinkingLevel;
  // The operator's upstream-provider restriction (C-6) is not the repository's to drop.
  if (current?.routing !== undefined && ref.provider === OPENROUTER) ref.routing = current.routing;
  return ref;
}

export function formatDuration(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} min`;
  if (ms >= 1000) return `${Math.round(ms / 1000)} s`;
  return `${ms} ms`;
}
