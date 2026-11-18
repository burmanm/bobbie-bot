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

export const PIPELINE_ROLES = ["reviewer", "verifier"] as const;
export type PipelineRole = (typeof PIPELINE_ROLES)[number];

export interface PipelineConfig {
  roles: Partial<Record<PipelineRole, ModelRef>>;
  limits: Record<PipelineRole, StepLimits> & {
    /** Whole-run spend cap (S-4 Limits). */
    runCostUsd: number;
    /** Above this many patch lines the review is chunked by directory (S-4 Phase 1). */
    chunkPatchLines: number;
  };
  skip: {
    draft: boolean;
    /** A PR carrying any of these labels is skipped (S-1: opt-out, round cap). */
    labels: string[];
  };
}

export const DEFAULT_LIMITS: PipelineConfig["limits"] = {
  reviewer: { timeoutMs: 20 * 60_000, idleTimeoutMs: 3 * 60_000, maxTurns: 120 },
  verifier: { timeoutMs: 8 * 60_000, idleTimeoutMs: 3 * 60_000, maxTurns: 40 },
  runCostUsd: 5,
  chunkPatchLines: 4000,
};

export const DEFAULT_SKIP: PipelineConfig["skip"] = { draft: true, labels: ["round-cap"] };

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
      routing: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    },
    { additionalProperties: false },
  ),
]);

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
          chunkPatchLines: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
    skip: Type.Optional(
      Type.Object(
        { draft: Type.Optional(Type.Boolean()), labels: Type.Optional(Type.Array(Type.String({ minLength: 1 }))) },
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
  runCostUsd?: number;
  chunkPatchLines?: number;
  skipDraft?: boolean;
  /** Per-role step limits (workflow inputs). */
  limits?: Partial<Record<PipelineRole, Partial<StepLimits>>>;
}

function roleFromYaml(v: Static<typeof RoleYaml>): ModelRef {
  if (typeof v === "string") return parseModelSpec(v);
  const ref = parseModelSpec(v.model);
  if (v.thinking !== undefined) ref.thinkingLevel = v.thinking;
  if (v.routing !== undefined) ref.routing = v.routing;
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
    skip: { ...DEFAULT_SKIP, labels: [...DEFAULT_SKIP.labels] },
  };
  for (const role of PIPELINE_ROLES) {
    const spec = inputs.models?.[role];
    if (spec !== undefined) {
      const ref = parseModelSpec(spec);
      const thinking = inputs.thinking?.[role];
      if (thinking !== undefined) ref.thinkingLevel = thinking;
      config.roles[role] = ref;
    }
  }
  for (const role of PIPELINE_ROLES) {
    const l = inputs.limits?.[role];
    if (l !== undefined) config.limits[role] = { ...config.limits[role], ...(l as StepLimits) };
  }
  if (inputs.runCostUsd !== undefined) config.limits.runCostUsd = inputs.runCostUsd;
  if (inputs.chunkPatchLines !== undefined) config.limits.chunkPatchLines = inputs.chunkPatchLines;
  if (inputs.skipDraft !== undefined) config.skip.draft = inputs.skipDraft;

  if (yamlText !== undefined) {
    const y = parseBotConfigYaml(yamlText);
    for (const role of PIPELINE_ROLES) {
      const r = y.roles?.[role];
      if (r !== undefined) config.roles[role] = roleFromYaml(r);
    }
    config.limits.reviewer = limitsFromYaml(config.limits.reviewer, y.limits?.reviewer);
    config.limits.verifier = limitsFromYaml(config.limits.verifier, y.limits?.verifier);
    if (y.limits?.runCostUsd !== undefined) config.limits.runCostUsd = y.limits.runCostUsd;
    if (y.limits?.chunkPatchLines !== undefined) config.limits.chunkPatchLines = y.limits.chunkPatchLines;
    if (y.skip?.draft !== undefined) config.skip.draft = y.skip.draft;
    if (y.skip?.labels !== undefined) config.skip.labels = y.skip.labels;
  }
  return config;
}
