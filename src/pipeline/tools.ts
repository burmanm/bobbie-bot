/**
 * The typed output tools of each step (D-4). Schemas for findings, questions,
 * needs-human notes and verdicts come from `core`; the coverage notes and the
 * re-check verdict are pipeline-only, since only the pipeline reads them.
 */
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  AskQuestionParams,
  crossFieldErrors,
  Evidence,
  NoteNeedsHumanParams,
  type OutputToolName,
  ReportFindingParams,
  SubmitVerdictParams,
} from "../core/index.ts";
import type { OutputTool } from "../agent/index.ts";

export const reportFinding = {
  name: "report_finding" as const,
  description: "Report one problem (A-3). One call per problem; list every location of it. Evidence quotes are checked mechanically.",
  parameters: ReportFindingParams,
  validate: (v: Static<typeof ReportFindingParams>) => rules("report_finding", v),
} satisfies OutputTool;

export const askQuestion = {
  name: "ask_question" as const,
  description:
    "Ask the author a question: a stated trade-off that may lead to a failure the repository cares about, or impact that depends on the environment and cannot be shown from the code.",
  parameters: AskQuestionParams,
  validate: (v: Static<typeof AskQuestionParams>) => rules("ask_question", v),
} satisfies OutputTool;

export const noteNeedsHuman = {
  name: "note_needs_human" as const,
  description:
    "Record a change the repository says always needs a human (for example a new lint suppression, or a changed or removed assertion in an existing test). Not a finding.",
  parameters: NoteNeedsHumanParams,
  validate: (v: Static<typeof NoteNeedsHumanParams>) => rules("note_needs_human", v),
} satisfies OutputTool;

export const submitVerdict = {
  name: "submit_verdict" as const,
  description: "Submit your verdict on the finding. Call exactly once.",
  parameters: SubmitVerdictParams,
  validate: (v: Static<typeof SubmitVerdictParams>) => rules("submit_verdict", v),
} satisfies OutputTool;

function rules(tool: OutputToolName, v: unknown): string | undefined {
  return crossFieldErrors(tool, v).join("; ") || undefined;
}

export const NoteParams = Type.Object(
  { item: Type.String({ minLength: 1, description: "One short line" }) },
  { additionalProperties: false },
);
export type Note = Static<typeof NoteParams>;

export const noteChecked = {
  name: "note_checked" as const,
  description: "Record one area you checked and found nothing wrong in, as one short line.",
  parameters: NoteParams,
} satisfies OutputTool;

export const noteNotRun = {
  name: "note_not_run" as const,
  description: "Record something you would have needed to run, build, probe or look up (tests, history, issue tracker) and could not.",
  parameters: NoteParams,
} satisfies OutputTool;

export const RECHECK_STATUSES = ["fixed", "still-open", "inconclusive"] as const;

export const SubmitRecheckParams = Type.Object(
  {
    status: Type.Enum(RECHECK_STATUSES),
    detail: Type.String({ minLength: 1, description: "For the PR author: what was checked (fixed) or the remaining case (still open)" }),
    evidence: Type.Array(Evidence, { description: "Required (at least one) when the status is fixed: the code that fixes it" }),
  },
  { additionalProperties: false },
);
export type Recheck = Static<typeof SubmitRecheckParams>;

export function recheckErrors(v: Recheck): string[] {
  const errors: string[] = [];
  for (const e of v.evidence) if (e.endLine < e.startLine) errors.push(`endLine ${e.endLine} is before startLine ${e.startLine} in ${e.path}`);
  if (v.status === "fixed" && v.evidence.length === 0) errors.push("a fixed status needs at least one evidence item citing the fix");
  return errors;
}

export const submitRecheck = {
  name: "submit_recheck" as const,
  description: "Submit whether the earlier finding is fixed at the new head. Call exactly once.",
  parameters: SubmitRecheckParams,
  validate: (v: Recheck): string | undefined => recheckErrors(v).join("; ") || undefined,
} satisfies OutputTool;

export const REVIEWER_TOOLS = [reportFinding, askQuestion, noteNeedsHuman, noteChecked, noteNotRun] as const;
export const VERIFIER_TOOLS = [submitVerdict] as const;
export const RECHECK_TOOLS = [submitRecheck] as const;

/** Defence in depth (S-5): re-validate a value against a tool's schema and rules. */
export function isValidRecheck(v: unknown): v is Recheck {
  return Value.Check(SubmitRecheckParams, v) && recheckErrors(v).length === 0;
}
