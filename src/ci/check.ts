/**
 * The always-run final step of the review job (S-9, C-1): the
 * `ai-review/<name>` check is completed even when the job died, timed out
 * or was cancelled, so no PR waits on it forever.
 *
 * Completes the newest check run of that name on the head SHA when it is
 * still queued or in progress; creates a completed one when none exists
 * (the job died before the pipeline opened it). A check that is already
 * completed is left alone — the pipeline completed it, or an earlier run
 * did.
 */
import type { CheckRunOutput, Github } from "./github.ts";

/** How the review step ended, as Actions reports it (`steps.<id>.outcome`). */
export const STEP_OUTCOMES = ["success", "failure", "cancelled", "skipped", ""] as const;

export function unfinishedOutput(outcome: string): CheckRunOutput {
  switch (outcome) {
    case "cancelled":
      return {
        title: "Could not complete: cancelled",
        summary:
          "The review job was cancelled before it finished: a newer push superseded it, someone cancelled the run, or it hit its time limit. The PR proceeds to human review (S-9).",
      };
    case "skipped":
      return {
        title: "Could not complete: not started",
        summary: "The review did not start, usually because the snapshots could not be prepared. The PR proceeds to human review (S-9).",
      };
    default:
      return {
        title: "Could not complete",
        summary: "The review job ended before the review finished (crash or time limit). The workflow log and the run record artifact have the details. The PR proceeds to human review (S-9).",
      };
  }
}

export type FinalizeAction = "none" | "completed" | "created";

export async function completeIfUnfinished(
  gh: Github,
  name: string,
  headSha: string,
  outcome: string,
  log: (line: string) => void,
): Promise<FinalizeAction> {
  const checkName = `ai-review/${name}`;
  const output = unfinishedOutput(outcome);
  const runs = await gh.listChecks(headSha, checkName);
  const latest = runs[0];
  if (latest !== undefined && latest.status === "completed") {
    log(`${checkName} on ${headSha.slice(0, 7)} is already completed (${latest.conclusion ?? "no conclusion"})`);
    return "none";
  }
  if (latest !== undefined) {
    try {
      await gh.completeCheck(latest.id, "neutral", output);
      log(`${checkName} on ${headSha.slice(0, 7)} was ${latest.status}; completed as neutral`);
      return "completed";
    } catch (e) {
      // Created by another identity (App vs. Actions token): it cannot be updated by this one.
      log(`could not complete check run ${latest.id}: ${e instanceof Error ? e.message : String(e)}; creating a completed one`);
    }
  }
  await gh.createCompletedCheck(checkName, headSha, "neutral", output);
  log(`${checkName} on ${headSha.slice(0, 7)} completed as neutral (created)`);
  return "created";
}
