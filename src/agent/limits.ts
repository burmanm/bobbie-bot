/**
 * Run deadline (S-4 Limits, S-9). The pipeline aborts the run signal with
 * `RUN_DEADLINE` as the reason when the whole run's time is up; a step then
 * stops as `timeout` with `stoppedBy: "deadline"`, not as `cancelled`, so
 * the run can still publish what it has. Any other abort is a cancellation
 * (for example a newer push).
 */
export const RUN_DEADLINE = "run-deadline";

export function stopReasonOf(signal: AbortSignal | undefined): "deadline" | "cancelled" {
  return signal?.reason === RUN_DEADLINE ? "deadline" : "cancelled";
}
