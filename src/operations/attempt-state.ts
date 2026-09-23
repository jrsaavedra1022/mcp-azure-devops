import type { Environment } from "./gateway.js";
const failures = new Set([
  "failed",
  "partiallySucceeded",
  "canceled",
  "cancelled",
  "rejected",
]);
/** A missing/unrecognized attempt status never inherits an old environment success. */
export function attemptOutcome(
  step: Environment["deploySteps"][number],
): "succeeded" | "failed" | "tracking" {
  if (
    failures.has(step.status ?? "") ||
    [
      "rejected",
      "canceled",
      "phaseCanceled",
      "phaseFailed",
      "phasePartiallySucceeded",
      "gateFailed",
    ].includes(step.operationStatus ?? "")
  )
    return "failed";
  if (step.status === "succeeded") return "succeeded";
  return "tracking";
}
