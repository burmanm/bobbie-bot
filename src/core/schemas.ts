/**
 * Output types the models produce through typed tools (D-4), and the
 * orchestrator's Finding built from them (A-3).
 *
 * The producer schemas are the parameter schemas of the tools
 * `report_finding`, `ask_question`, `note_needs_human` (S-4) and
 * `submit_verdict` (S-5). The agent / extension layer registers them as-is;
 * the orchestrator re-validates with the same schemas as defence in depth.
 *
 * Enums are plain `{ enum: [...] }` schemas (typebox `Type.Enum`), so core
 * does not need pi-ai's `StringEnum` helper (A-2: core imports nothing from pi).
 */
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

export const TAGS = ["important", "nit", "pre-existing"] as const;
export type Tag = (typeof TAGS)[number];

export const CATEGORIES = [
  "correctness",
  "security",
  "concurrency",
  "data-loss",
  "compatibility",
  "performance",
  "error-handling",
  "tests",
  "hygiene",
  "docs",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const ROOTS = ["head", "base", "modcache"] as const;
export type Root = (typeof ROOTS)[number];

export const Tag = Type.Enum(TAGS, {
  description: "important: introduced by this PR and must be fixed; nit: introduced, minor; pre-existing: already there before this PR",
});
export const Category = Type.Enum(CATEGORIES, {
  description: "For clustering and metrics only, never shown",
});

export const Location = Type.Object(
  {
    path: Type.String({ minLength: 1, description: "Repository-relative path in the PR head" }),
    startLine: Type.Integer({ minimum: 1 }),
    endLine: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type Location = Static<typeof Location>;

export const Evidence = Type.Object(
  {
    root: Type.Enum(ROOTS, {
      description: "head: PR head snapshot; base: base snapshot; modcache: library source at the pinned version",
    }),
    path: Type.String({ minLength: 1, description: "Path relative to the root" }),
    startLine: Type.Integer({ minimum: 1 }),
    endLine: Type.Integer({ minimum: 1 }),
    quote: Type.String({ minLength: 1, description: "Exact text copied from the cited lines" }),
  },
  { additionalProperties: false },
);
export type Evidence = Static<typeof Evidence>;

/** A-3, producer-set fields: the `report_finding` tool's parameter schema. */
export const ReportFindingParams = Type.Object(
  {
    tag: Tag,
    category: Category,
    locations: Type.Array(Location, {
      minItems: 1,
      description: "First is the anchor; the rest are other instances of the same problem",
    }),
    title: Type.String({ minLength: 1 }),
    body: Type.String({
      minLength: 1,
      description: "The concrete failure: what breaks, for whom, when, and how often the trigger has to happen",
    }),
    evidence: Type.Array(Evidence, { minItems: 1 }),
    traced: Type.Array(Type.String(), { description: "What was actually read" }),
    assumed: Type.Array(Type.String(), { description: "What was assumed without reading" }),
    suggestion: Type.Optional(Type.String({ description: "Replacement text for a GitHub suggestion block" })),
    ruleRefs: Type.Optional(
      Type.Array(Type.String(), { description: "REVIEW.md / AGENTS.md / guideline headings the finding applies" }),
    ),
    proposedIssue: Type.Optional(
      Type.String({
        minLength: 1,
        description: "pre-existing only: one-line tech-debt issue title, or the URL of an existing issue",
      }),
    ),
    mechanizable: Type.Object(
      {
        possible: Type.Boolean({ description: "Could lint or a script have caught this?" }),
        sketch: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    confidence: Type.Number({ minimum: 0, maximum: 1, description: "Recorded for analysis only, never a gate" }),
  },
  { additionalProperties: false },
);
export type ProducerFinding = Static<typeof ReportFindingParams>;

/** A-3 Question: `ask_question` parameters (I-2 #6). */
export const AskQuestionParams = Type.Object(
  {
    locations: Type.Array(Location),
    body: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type Question = Static<typeof AskQuestionParams>;

/** A-3 Needs-human note: `note_needs_human` parameters (I-2 #5). */
export const NoteNeedsHumanParams = Type.Object(
  {
    what: Type.String({ minLength: 1, description: 'e.g. "new //nolint directive"' }),
    locations: Type.Array(Location, { minItems: 1 }),
    explainedInDescription: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type NeedsHumanNote = Static<typeof NoteNeedsHumanParams>;

export const VERDICTS = ["refuted", "confirmed", "inconclusive"] as const;
export type VerdictKind = (typeof VERDICTS)[number];

/** S-5 verifier output: `submit_verdict` parameters. */
export const SubmitVerdictParams = Type.Object(
  {
    verdict: Type.Enum(VERDICTS),
    reasoning: Type.String({ minLength: 1, description: "What was read and why it supports the verdict" }),
    evidence: Type.Array(Evidence, { description: "Required (at least one) when the verdict is refuted" }),
  },
  { additionalProperties: false },
);
export type Verdict = Static<typeof SubmitVerdictParams>;

/** The typed output tools and their values (spike-r0-findings, proposed AgentStep). */
export interface OutputTools {
  report_finding: ProducerFinding;
  ask_question: Question;
  note_needs_human: NeedsHumanNote;
  submit_verdict: Verdict;
}
export type OutputToolName = keyof OutputTools;
export type ToolOutput = {
  [K in OutputToolName]: { tool: K; value: OutputTools[K] };
}[OutputToolName];

export const OUTPUT_TOOL_SCHEMAS: { readonly [K in OutputToolName]: TSchema } = {
  report_finding: ReportFindingParams,
  ask_question: AskQuestionParams,
  note_needs_human: NoteNeedsHumanParams,
  submit_verdict: SubmitVerdictParams,
};

function checkRanges(items: ReadonlyArray<{ path: string; startLine: number; endLine: number }>, errors: string[]) {
  for (const l of items) {
    if (l.endLine < l.startLine) errors.push(`endLine ${l.endLine} is before startLine ${l.startLine} in ${l.path}`);
  }
}

/**
 * Cross-field rules JSON Schema cannot express (S-5). Returns error messages;
 * empty means valid. The tool's `execute()` throws with these, so they reach
 * the model as a tool error; the orchestrator re-checks.
 */
export function crossFieldErrors(tool: OutputToolName, value: unknown): string[] {
  const errors: string[] = [];
  switch (tool) {
    case "report_finding": {
      const f = value as ProducerFinding;
      checkRanges(f.locations, errors);
      checkRanges(f.evidence, errors);
      if (f.proposedIssue !== undefined && f.tag !== "pre-existing") {
        errors.push('proposedIssue is only allowed when tag is "pre-existing"');
      }
      break;
    }
    case "ask_question":
    case "note_needs_human":
      checkRanges((value as Question | NeedsHumanNote).locations, errors);
      break;
    case "submit_verdict": {
      const v = value as Verdict;
      checkRanges(v.evidence, errors);
      if (v.verdict === "refuted" && v.evidence.length === 0) {
        errors.push("a refuted verdict needs at least one evidence item proving the finding wrong");
      }
      break;
    }
  }
  return errors;
}

/** Schema plus cross-field validation. Returns error messages; empty means valid. */
export function validateOutput(tool: OutputToolName, value: unknown): string[] {
  const schema = OUTPUT_TOOL_SCHEMAS[tool];
  if (!Value.Check(schema, value)) {
    return [...Value.Errors(schema, value)].map((e) => `${e.instancePath || "/"}: ${e.message}`);
  }
  return crossFieldErrors(tool, value);
}

export const STATUSES = [
  "proposed",
  "verified",
  "unverified",
  "refuted",
  "duplicate",
  "over-limit",
  "published",
] as const;
export type Status = (typeof STATUSES)[number];

/**
 * A-3 Finding: producer fields plus orchestrator-owned fields.
 * `statusReason` is required for every status other than `published`
 * (and is set by core for every status core assigns).
 */
export const Finding = Type.Object(
  {
    ...ReportFindingParams.properties,
    id: Type.String({ minLength: 1 }),
    fingerprint: Type.String({ minLength: 1 }),
    fingerprintVersion: Type.Integer({ minimum: 1 }),
    source: Type.String({ pattern: "^reviewer:.+$" }),
    status: Type.Enum(STATUSES),
    statusReason: Type.Optional(Type.String({ minLength: 1 })),
    /** Set when grounding re-tagged the finding (S-5). */
    retaggedFrom: Type.Optional(Tag),
    verdict: Type.Optional(SubmitVerdictParams),
    /** The saved codemode script that reported it, in the run's `scripts.json` (A-6). */
    scriptId: Type.Optional(Type.String({ pattern: "^script-[1-9][0-9]*$" })),
  },
  { additionalProperties: false },
);
export type Finding = Static<typeof Finding>;
