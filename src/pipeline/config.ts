/**
 * Bot configuration (A-5, C-2, P-4): workflow inputs (CLI flags here),
 * overridden by `.review/review-bot.yaml` from the base branch.
 *
 * There is **no default model** anywhere in code: a role without a model is
 * a configuration error for `reviewer`, and turns adversarial verification
 * off for `verifier` (reported under "Not run"). Limits do have defaults:
 * they are safety, not tuning (P-9).
 */
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { parse as parseYaml } from "yaml";
import type { ModelRef, StepLimits, ThinkingLevel } from "../agent/index.ts";
import { cloneSkipConfig, DEFAULT_SKIP, type SkipConfig } from "./skip.ts";

export const PIPELINE_ROLES = ["reviewer", "verifier"] as const;
export type PipelineRole = (typeof PIPELINE_ROLES)[number];

export interface PipelineConfig {
  roles: Partial<Record<PipelineRole, ModelRef>>;
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


export class ConfigError extends Error {
  override name = "ConfigError";
}

const THINKING = ["off", "minimal", "low", "medium", "high"] as const;

/** "provider/model-id", e.g. "openrouter/vendor/model". The id may contain "/" and ":". */
export function parseModelSpec(spec: string): ModelRef {
  const s = spec.trim();
  const slash = s.indexOf("/");
  if (slash <= 0 || slash === s.length - 1) throw new ConfigError(`model "${spec}" must be "<provider>/<model id>"`);
  return { provider: s.slice(0, slash), id: s.slice(slash + 1) };
}

export function formatModel(m: ModelRef): string {
  return `${m.provider}/${m.id}`;
}

const LimitsYaml = Type.Object(
  {
    timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    idleTimeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
    maxCostUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  },
  { additionalProperties: false },
);

const RoleYaml = Type.Union([
  Type.String({ minLength: 3 }),
  Type.Object(
    {
      model: Type.String({ minLength: 3 }),
      thinking: Type.Optional(Type.Enum(THINKING)),
      /** OpenRouter only: the upstream providers allowed to serve the model (routing `only`). */
      providers: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
      routing: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    },
    { additionalProperties: false },
  ),
]);

const LabelList = Type.Array(Type.String({ minLength: 1 }));

/** `.review/review-bot.yaml` (A-5). Bot settings only; never review guidance. */
export const BotConfigYaml = Type.Object(
  {
    roles: Type.Optional(Type.Object({ reviewer: Type.Optional(RoleYaml), verifier: Type.Optional(RoleYaml) }, { additionalProperties: false })),
    limits: Type.Optional(
      Type.Object(
        {
          reviewer: Type.Optional(LimitsYaml),
          verifier: Type.Optional(LimitsYaml),
          runCostUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
          runTimeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
          chunkPatchLines: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
    skip: Type.Optional(
      Type.Object(
        {
          draft: Type.Optional(Type.Boolean()),
          labels: Type.Optional(LabelList),
          optOutLabels: Type.Optional(LabelList),
          roundCapLabels: Type.Optional(LabelList),
          dependencies: Type.Optional(
            Type.Object(
              { labels: Type.Optional(LabelList), paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }))) },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    /**
     * C-9 waiting for CI, used by the gate job only; accepted and ignored by
     * the review run. `require`: off, required (the base branch's required
     * status checks minus ai-review/*), or check-run / status-context /
     * workflow names. `timeout`: "6h", "90m", or seconds.
     */
    ci: Type.Optional(
      Type.Object(
        {
          require: Type.Optional(Type.Union([Type.Enum(["off", "required"] as const), Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 50 })])),
          onFailure: Type.Optional(Type.Enum(["skip", "review"] as const)),
          timeout: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Number({ exclusiveMinimum: 0 })])),
        },
        { additionalProperties: false },
      ),
    ),
    /** C-4, used by the R-2 gate job; accepted and ignored by the dry run. */
    authorization: Type.Optional(
      Type.Object(
        { label: Type.Optional(Type.String()), lifetime: Type.Optional(Type.Enum(["per-push", "per-pr"] as const)) },
        { additionalProperties: false },
      ),
    ),
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

function roleFromYaml(v: Static<typeof RoleYaml>, where: string): ModelRef {
  if (typeof v === "string") return parseModelSpec(v);
  let ref = parseModelSpec(v.model);
  if (v.thinking !== undefined) ref.thinkingLevel = v.thinking;
  if (v.routing !== undefined) ref.routing = v.routing;
  if (v.providers !== undefined) ref = withProviders(ref, v.providers, where);
  return ref;
}

function limitsFromYaml(base: StepLimits, y: Static<typeof LimitsYaml> | undefined): StepLimits {
  if (y === undefined) return base;
  const out: StepLimits = { ...base };
  if (y.timeoutSeconds !== undefined) out.timeoutMs = Math.round(y.timeoutSeconds * 1000);
  if (y.idleTimeoutSeconds !== undefined) out.idleTimeoutMs = Math.round(y.idleTimeoutSeconds * 1000);
  if (y.maxTurns !== undefined) out.maxTurns = y.maxTurns;
  if (y.maxCostUsd !== undefined) out.maxCostUsd = y.maxCostUsd;
  return out;
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

/** Inputs first, then the base branch's `.review/review-bot.yaml` on top (C-2). */
export function resolveConfig(inputs: ConfigInputs, yamlText?: string): PipelineConfig {
  const config: PipelineConfig = {
    roles: {},
    limits: { ...DEFAULT_LIMITS, reviewer: { ...DEFAULT_LIMITS.reviewer }, verifier: { ...DEFAULT_LIMITS.verifier } },
    skip: cloneSkipConfig(DEFAULT_SKIP),
  };
  for (const role of PIPELINE_ROLES) {
    const spec = inputs.models?.[role];
    if (spec !== undefined) {
      let ref = parseModelSpec(spec);
      const thinking = inputs.thinking?.[role];
      if (thinking !== undefined) ref.thinkingLevel = thinking;
      const providers = inputs.providers?.[role];
      if (providers !== undefined) ref = withProviders(ref, providers, `--providers ${role}`);
      config.roles[role] = ref;
    }
  }
  for (const role of PIPELINE_ROLES) {
    if (inputs.providers?.[role] !== undefined && inputs.models?.[role] === undefined) {
      throw new ConfigError(`--providers ${role}: no model is given for the ${role} role`);
    }
  }
  for (const role of PIPELINE_ROLES) {
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

  if (yamlText !== undefined) {
    const y = parseBotConfigYaml(yamlText);
    for (const role of PIPELINE_ROLES) {
      const r = y.roles?.[role];
      if (r !== undefined) config.roles[role] = roleFromYaml(r, `.review/review-bot.yaml roles.${role}`);
    }
    config.limits.reviewer = limitsFromYaml(config.limits.reviewer, y.limits?.reviewer);
    config.limits.verifier = limitsFromYaml(config.limits.verifier, y.limits?.verifier);
    if (y.limits?.runCostUsd !== undefined) config.limits.runCostUsd = y.limits.runCostUsd;
    if (y.limits?.runTimeoutSeconds !== undefined) config.limits.runTimeoutMs = Math.round(y.limits.runTimeoutSeconds * 1000);
    if (y.limits?.chunkPatchLines !== undefined) config.limits.chunkPatchLines = y.limits.chunkPatchLines;
    if (y.skip?.draft !== undefined) config.skip.draft = y.skip.draft;
    if (y.skip?.labels !== undefined) config.skip.labels = y.skip.labels;
    if (y.skip?.optOutLabels !== undefined) config.skip.optOutLabels = y.skip.optOutLabels;
    if (y.skip?.roundCapLabels !== undefined) config.skip.roundCapLabels = y.skip.roundCapLabels;
    if (y.skip?.dependencies?.labels !== undefined) config.skip.dependencies.labels = y.skip.dependencies.labels;
    if (y.skip?.dependencies?.paths !== undefined) config.skip.dependencies.paths = y.skip.dependencies.paths;
  }
  for (const role of PIPELINE_ROLES) {
    const ref = config.roles[role];
    if (ref?.routing !== undefined && ref.provider !== OPENROUTER) {
      throw new ConfigError(`roles.${role}: routing preferences need an ${OPENROUTER} model, not "${formatModel(ref)}"`);
    }
  }
  return config;
}

/**
 * A duration as given on the command line: "90" or "90s" (seconds), "20m",
 * "1.5h". Returns milliseconds, or undefined when it is not one.
 */
export function parseDuration(text: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  const ms = unit === "ms" ? n : unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 3_600_000;
  return ms > 0 && Number.isFinite(ms) ? Math.round(ms) : undefined;
}

export function formatDuration(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} min`;
  if (ms >= 1000) return `${Math.round(ms / 1000)} s`;
  return `${ms} ms`;
}
