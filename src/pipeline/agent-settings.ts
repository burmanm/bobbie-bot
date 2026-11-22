/**
 * The operator's agent directory `settings.json` as the bot reads it (F-7,
 * R-1a step 2): plain JSON, without loading pi, so the gate can use it. This
 * module must not import pi, nor anything that does.
 *
 * The file is pi's. Its other keys are tolerated and left to pi; only
 * `reviewBot`, `enabledModels` and `packages` are read and checked here. pi
 * treats a malformed file as a warning; for the bot it is a configuration
 * error (F-3).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import type { ModelRef, StepLimits, ThinkingLevel } from "../agent/index.ts";

export const SETTINGS_FILE = "settings.json";

export const PIPELINE_ROLES = ["reviewer", "verifier"] as const;
export type PipelineRole = (typeof PIPELINE_ROLES)[number];

export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * A configured value as quoted in an error. Errors reach the check and a PR
 * comment, and the value may come from a base branch (C-3): bounded, on one
 * line, and unable to mention anyone or inject HTML.
 */
export function quoteValue(value: string): string {
  return JSON.stringify(value.slice(0, 120)).replace(/[<>@`]/g, "?");
}

// ---- model syntax ---------------------------------------------------------

/** pi's thinking levels (`--thinking`, the `--model` suffix). */
const PI_THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * `provider/id[:thinking]`, as pi's `--model` takes it (F-7). Only a
 * recognised level after the last ":" is a suffix, so the id may contain "/"
 * and ":": "openrouter/vendor/model:free" keeps its id.
 *
 * pi also consults its catalog, which is not available here: the provider
 * ends at the first "/", and an id that itself ends in a level needs the
 * level spelled out after it.
 */
export function parseModelSpec(spec: string): ModelRef {
  const s = spec.trim();
  const slash = s.indexOf("/");
  const rest = s.slice(slash + 1);
  const colon = rest.lastIndexOf(":");
  const level = colon !== -1 && PI_THINKING_LEVELS.includes(rest.slice(colon + 1)) ? rest.slice(colon + 1) : undefined;
  const id = level === undefined ? rest : rest.slice(0, colon);
  if (slash <= 0 || id === "") throw new ConfigError(`model ${quoteValue(spec)} must be "<provider>/<model id>[:<thinking>]"`);
  const ref: ModelRef = { provider: s.slice(0, slash), id };
  // src/agent's ThinkingLevel lacks pi's xhigh and max until R-1a step 2b widens it.
  if (level !== undefined) ref.thinkingLevel = level as ThinkingLevel;
  return ref;
}

// ---- values shared with `.review/review-bot.yaml` -------------------------

/** setTimeout fires at once above this. */
const MAX_SECONDS = Math.floor((2 ** 31 - 1) / 1000);
const Seconds = Type.Number({ exclusiveMinimum: 0, maximum: MAX_SECONDS });
const Usd = Type.Number({ exclusiveMinimum: 0 });

export const StepLimitsSchema = Type.Object(
  {
    timeoutSeconds: Type.Optional(Seconds),
    idleTimeoutSeconds: Type.Optional(Seconds),
    maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
    maxCostUsd: Type.Optional(Usd),
  },
  { additionalProperties: false },
);

export const LimitsSchema = Type.Object(
  {
    reviewer: Type.Optional(StepLimitsSchema),
    verifier: Type.Optional(StepLimitsSchema),
    runCostUsd: Type.Optional(Usd),
    runTimeoutSeconds: Type.Optional(Seconds),
    chunkPatchLines: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const LabelList = Type.Array(Type.String({ minLength: 1 }));

/** S-1. */
export const SkipSchema = Type.Object(
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
);

/**
 * C-9 waiting for CI, used by the gate job only. `require`: off, required
 * (the base branch's required status checks minus ai-review/*), or
 * check-run / status-context / workflow names. `timeout`: "6h", "90m", or
 * seconds.
 */
export const CiSchema = Type.Object(
  {
    require: Type.Optional(
      Type.Union([Type.Enum(["off", "required"] as const), Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 50 })]),
    ),
    onFailure: Type.Optional(Type.Enum(["skip", "review"] as const)),
    timeout: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Number({ exclusiveMinimum: 0 })])),
  },
  { additionalProperties: false },
);

/** C-4, used by the gate job only. */
export const AuthorizationSchema = Type.Object(
  { label: Type.Optional(Type.String()), lifetime: Type.Optional(Type.Enum(["per-push", "per-pr"] as const)) },
  { additionalProperties: false },
);

export function secondsToMs(seconds: number): number {
  return Math.max(1, Math.round(seconds * 1000));
}

export function stepLimitsFromSchema(v: Static<typeof StepLimitsSchema> | undefined): Partial<StepLimits> {
  const out: Partial<StepLimits> = {};
  if (v?.timeoutSeconds !== undefined) out.timeoutMs = secondsToMs(v.timeoutSeconds);
  if (v?.idleTimeoutSeconds !== undefined) out.idleTimeoutMs = secondsToMs(v.idleTimeoutSeconds);
  if (v?.maxTurns !== undefined) out.maxTurns = v.maxTurns;
  if (v?.maxCostUsd !== undefined) out.maxCostUsd = v.maxCostUsd;
  return out;
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

// ---- settings.json --------------------------------------------------------

/** An exact tool name, or `+name` / `-name`. pi takes no patterns here. */
const ToolEntry = Type.String({ pattern: "^[+-]?[A-Za-z0-9_][A-Za-z0-9_.:-]*$" });

const RoleSettings = Type.Object(
  {
    /** `provider/id[:thinking]`. May instead come from a workflow input. */
    model: Type.Optional(Type.String({ minLength: 3 })),
    /** pi's `defaultTools` syntax, relative to the role's default; see `resolveRoleTools`. */
    tools: Type.Optional(Type.Array(ToolEntry)),
  },
  { additionalProperties: false },
);

/** The `reviewBot` key (F-7). */
export const ReviewBotSettings = Type.Object(
  {
    roles: Type.Optional(Type.Object({ reviewer: Type.Optional(RoleSettings), verifier: Type.Optional(RoleSettings) }, { additionalProperties: false })),
    limits: Type.Optional(LimitsSchema),
    skip: Type.Optional(SkipSchema),
    ci: Type.Optional(CiSchema),
    authorization: Type.Optional(AuthorizationSchema),
  },
  { additionalProperties: false },
);
export type ReviewBotSettings = Static<typeof ReviewBotSettings>;

/** A pi package source. Pins and paths are checked by setup (R-1a step 4). */
const PackageSource = Type.Union([
  Type.String({ minLength: 1 }),
  Type.Object({
    source: Type.String({ minLength: 1 }),
    autoload: Type.Optional(Type.Boolean()),
    extensions: Type.Optional(Type.Array(Type.String())),
    skills: Type.Optional(Type.Array(Type.String())),
    prompts: Type.Optional(Type.Array(Type.String())),
    themes: Type.Optional(Type.Array(Type.String())),
  }),
]);
export type PackageSource = Static<typeof PackageSource>;

/** pi's other keys are allowed and not looked at. */
const SettingsFile = Type.Object({
  reviewBot: Type.Optional(ReviewBotSettings),
  enabledModels: Type.Optional(Type.Array(Type.String({ pattern: "\\S" }))),
  packages: Type.Optional(Type.Array(PackageSource)),
});

export interface AgentSettings {
  reviewBot: ReviewBotSettings;
  /**
   * pi's model patterns. Empty when absent: pi then offers every model, but
   * for the bot the repository then cannot change a model at all (F-7).
   */
  enabledModels: string[];
  packages: PackageSource[];
}

/** Paths and messages only: the file may hold credentials, so never its values. */
function schemaErrors(schema: TSchema, data: unknown): string {
  return [...Value.Errors(schema, data)]
    .filter((e) => e.keyword !== "boolean")
    .slice(0, 5)
    .map((e) => {
      const unknown = e.keyword === "additionalProperties" ? ` (${e.params.additionalProperties.join(", ")})` : "";
      return `${e.instancePath || "/"}: ${e.message}${unknown}`;
    })
    .join("; ");
}

/** Parse and check the text of a `settings.json`. */
export function parseAgentSettings(text: string, file: string = SETTINGS_FILE): AgentSettings {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, "")); // pi accepts a byte order mark too
  } catch (e) {
    // V8's message can quote the file, which may hold credentials: keep only the position.
    const at = /at position \d+(?: \(line \d+ column \d+\))?/.exec(e instanceof Error ? e.message : "")?.[0];
    throw new ConfigError(`${file} is not valid JSON${at === undefined ? "" : ` (${at})`}`);
  }
  if (!Value.Check(SettingsFile, data)) throw new ConfigError(`${file} is invalid: ${schemaErrors(SettingsFile, data)}`);

  const reviewBot = data.reviewBot ?? {};
  for (const role of PIPELINE_ROLES) {
    const model = reviewBot.roles?.[role]?.model;
    if (model === undefined) continue;
    try {
      parseModelSpec(model);
    } catch {
      throw new ConfigError(`${file} is invalid: /reviewBot/roles/${role}/model: must be "<provider>/<model id>[:<thinking>]"`);
    }
  }
  const timeout = reviewBot.ci?.timeout;
  if (typeof timeout === "string" && parseDuration(timeout) === undefined) {
    throw new ConfigError(`${file} is invalid: /reviewBot/ci/timeout: must be a duration such as 6h or 90m`);
  }
  return { reviewBot, enabledModels: data.enabledModels ?? [], packages: data.packages ?? [] };
}

/**
 * Read `<agentDir>/settings.json`. A directory without one has no settings
 * (it may hold only `models.json`); a directory or file that cannot be read
 * is an error, so a wrong path is never taken for "no configuration".
 */
export function readAgentSettings(agentDir: string): AgentSettings {
  const file = join(agentDir, SETTINGS_FILE);
  let text = "{}";
  try {
    // Listed, not probed, so a dangling link is an error and not an absent file.
    if (readdirSync(agentDir).includes(SETTINGS_FILE)) text = readFileSync(file, "utf8");
  } catch (e) {
    throw new ConfigError(`cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? "unknown error"}`);
  }
  return parseAgentSettings(text, file);
}

/**
 * A role's tool names from its `tools` setting, as pi resolves
 * `defaultTools`: plain names replace the default, then `+name` adds and
 * `-name` removes, in list order; an empty list selects none.
 *
 * `defaults` is the role's read-only set (S-4) and has no fallback on
 * purpose: pi's own default has bash and is never inherited (F-7).
 */
export function resolveRoleTools(entries: readonly string[] | undefined, defaults: readonly string[]): string[] {
  if (entries === undefined) return [...defaults];
  const plain = entries.filter((e) => !/^[+-]/.test(e));
  const tools = new Set(plain.length > 0 || entries.length === 0 ? plain : defaults);
  for (const entry of entries) {
    if (entry.startsWith("+")) tools.add(entry.slice(1));
    else if (entry.startsWith("-")) tools.delete(entry.slice(1));
  }
  return [...tools];
}
