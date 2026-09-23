import { AppError } from "../errors.js";
import type { Environment, Release } from "./gateway.js";
import type { Operation } from "./catalog.js";
import { digest } from "./catalog.js";
const busyStates = new Set(["inProgress", "queued", "scheduled"]);
export function classifyEnvironmentCondition(
  c: Environment["conditions"][number],
) {
  if (c.conditionType === "environmentState") return "dependency";
  if (c.conditionType === "artifact") return "artifactFilter";
  if (c.conditionType === "event" && c.name === "ReleaseStarted")
    return "releaseStart";
  return "unknown";
}
export function findDirectDownstreamDependencies(
  release: Release,
  env: Environment,
) {
  return release.environments.filter(
    (other) =>
      other.id !== env.id &&
      other.conditions.some(
        (c) =>
          classifyEnvironmentCondition(c) === "dependency" &&
          c.name.toLowerCase() === env.name.toLowerCase(),
      ),
  );
}
/** Unknown trigger payloads are never logged or guessed to be safe. */
export function validateEnvironmentPolicy(
  release: Release,
  selected: Environment,
  policy: Operation,
  changesGlobal = false,
) {
  const names = new Map<string, Environment>();
  const ids = new Set<number>();
  for (const e of release.environments) {
    if (names.has(e.name.toLowerCase()) || ids.has(e.id))
      throw new AppError(
        "UNVERIFIED_TRIGGERS",
        "Stage identities are ambiguous; independence cannot be established.",
      );
    names.set(e.name.toLowerCase(), e);
    ids.add(e.id);
  }
  const edges = new Map<number, Set<number>>(
    release.environments.map((e) => [e.id, new Set()]),
  );
  for (const e of release.environments) {
    for (const trigger of e.environmentTriggers) {
      const raw =
        trigger && typeof trigger === "object"
          ? (trigger as Record<string, unknown>).triggerType
          : undefined;
      const type =
        raw === "deploymentGroupRedeploy" || raw === "rollbackRedeploy"
          ? raw
          : "unknown";
      throw new AppError(
        "UNVERIFIED_TRIGGERS",
        `Stage "${e.name}" (${e.id}) has an unsupported ${type} environment trigger; extra redeploys cannot be bounded.`,
      );
    }
    for (const c of e.conditions) {
      const kind = classifyEnvironmentCondition(c);
      if (kind === "unknown")
        throw new AppError(
          "UNVERIFIED_TRIGGERS",
          `Stage "${e.name}" (${e.id}) has an unknown condition type or event.`,
        );
      if (kind === "dependency") {
        const parent = names.get(c.name.toLowerCase());
        if (!parent || parent.id === e.id)
          throw new AppError(
            "UNVERIFIED_TRIGGERS",
            `Stage "${e.name}" (${e.id}) has an unresolved dependency.`,
          );
        edges.get(parent.id)!.add(e.id);
        edges.get(e.id)!.add(parent.id);
      }
    }
  }
  const related = new Set([selected.id]),
    pending = [selected.id];
  while (pending.length)
    for (const id of edges.get(pending.pop()!)!)
      if (!related.has(id)) {
        related.add(id);
        pending.push(id);
      }
  for (const e of release.environments) {
    const attempt = [...e.deploySteps].sort((a, b) => b.attempt - a.attempt)[0];
    const running =
      busyStates.has(e.status) ||
      (attempt &&
        (busyStates.has(attempt.status ?? "") ||
          [
            "queued",
            "scheduled",
            "pending",
            "approved",
            "deferred",
            "phaseInProgress",
            "queuedForAgent",
            "queuedForPipeline",
            "cancelling",
            "evaluatingGates",
            "manualInterventionPending",
          ].includes(attempt.operationStatus ?? "")));
    if (running && (related.has(e.id) || changesGlobal))
      throw new AppError(
        "DEPLOYMENT_BUSY",
        `Stage "${e.name}" (${e.id}) has an active, queued or scheduled deployment and shares dependencies or release variables.`,
      );
  }
  if (
    policy.deployment.downstreamPolicy !== "allow" &&
    findDirectDownstreamDependencies(release, selected).length
  )
    throw new AppError(
      "DOWNSTREAM_TRIGGER",
      "Another stage depends on the selected environment; isolated redeploy cannot be guaranteed.",
    );
}
/** Stable configuration, excluding execution status, timestamps and passthrough metadata. */
export function environmentConfiguration(release: Release) {
  return release.environments
    .map((e) => ({
      id: e.id,
      definitionEnvironmentId: e.definitionEnvironmentId,
      name: e.name,
      conditions: e.conditions
        .map((c) => ({
          conditionType: c.conditionType,
          name: c.name,
          value: c.value,
        }))
        .sort((a, b) => digest(a).localeCompare(digest(b))),
      // Nonempty triggers are rejected by validateEnvironmentPolicy.
      triggerCount: e.environmentTriggers.length,
    }))
    .sort((a, b) => a.id - b.id);
}
