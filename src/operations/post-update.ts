import { z } from "zod";
import { AppError } from "../errors.js";
import { digest } from "./catalog.js";
import type { Execution } from "./engine.js";
import { matchesBranch, type Release } from "./gateway.js";
import { matchesExpectedVariable } from "./variable-state.js";
import {
  environmentConfiguration,
  validateEnvironmentPolicy,
} from "./environment-policy.js";
const ref = z.object({
  id: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
});
const artifact = z.object({
  alias: z.string(),
  type: z.string(),
  definitionReference: z
    .object({
      version: ref.optional(),
      branch: z.object({ id: z.string().nullable().optional() }).optional(),
      definition: z.object({ id: z.string().nullable().optional() }).optional(),
    })
    .optional(),
});
export function artifactIdentity(artifacts: unknown[]) {
  const parsed = z.array(artifact).safeParse(artifacts);
  if (!parsed.success)
    throw new AppError(
      "POST_UPDATE_ARTIFACT_CHANGED",
      "Artifact identity cannot be verified.",
    );
  return parsed.data.sort((a, b) => digest(a).localeCompare(digest(b)));
}
export function executionEnvironment(saved: Release, r: Execution) {
  const candidates = saved.environments.filter(
    (e) =>
      e.id === r.environmentId ||
      e.definitionEnvironmentId ===
        r.target.environment.definitionEnvironmentId,
  );
  const env = candidates[0];
  if (
    saved.id !== r.releaseId ||
    saved.releaseDefinition.id !== r.target.definitionId ||
    saved.status !== "active" ||
    candidates.length !== 1 ||
    !env ||
    env.id !== r.environmentId ||
    env.definitionEnvironmentId !==
      r.target.environment.definitionEnvironmentId ||
    env.name !== r.environmentName
  )
    throw new AppError(
      "POST_UPDATE_TARGET_CHANGED",
      "Release or selected stage identity/status changed.",
    );
  return env;
}
export function expectedVariablesVisible(saved: Release, r: Execution) {
  const env = executionEnvironment(saved, r);
  return r.changes.every((d) =>
    matchesExpectedVariable(
      (d.scope === "release" ? saved.variables : env.variables)[d.name],
      d.after,
    ),
  );
}
export function verifyPostUpdateInvariants(
  before: Release,
  saved: Release,
  r: Execution,
  checkVariables = true,
): void {
  const env = executionEnvironment(saved, r);
  if (
    digest(artifactIdentity(before.artifacts)) !==
    digest(artifactIdentity(saved.artifacts))
  )
    throw new AppError(
      "POST_UPDATE_ARTIFACT_CHANGED",
      "Artifact identity, version or branch changed; redeploy was not requested.",
    );
  if (
    r.target.selection.sourceBranch &&
    !matchesBranch(saved, r.target.selection.sourceBranch)
  )
    throw new AppError(
      "POST_UPDATE_ARTIFACT_CHANGED",
      "Configured source branch no longer matches.",
    );
  if (
    digest(environmentConfiguration(before)) !==
    digest(environmentConfiguration(saved))
  )
    throw new AppError(
      "POST_UPDATE_TARGET_CHANGED",
      "Stage dependencies or identities changed after update.",
    );
  validateEnvironmentPolicy(
    saved,
    env,
    r.policy,
    r.changes.some(
      (d) =>
        d.scope === "release" && !matchesExpectedVariable(d.before, d.after),
    ),
  );
  if (
    Math.max(0, ...env.deploySteps.map((s) => s.attempt)) >= r.expectedAttempt
  )
    throw new AppError(
      "DEPLOYMENT_BUSY",
      "A new deployment attempt appeared before the redeploy request.",
    );
  // Detect real changes to other variables, without comparing server-managed metadata.
  for (const [scope, oldVars, newVars] of [
    ["release", before.variables, saved.variables],
    ...before.environments.map(
      (e) =>
        [
          String(e.id),
          e.variables,
          saved.environments.find((x) => x.id === e.id)!.variables,
        ] as const,
    ),
  ] as const) {
    const changed = new Set(
      r.changes
        .filter((d) =>
          d.scope === "release"
            ? scope === "release"
            : scope === String(r.environmentId),
        )
        .map((d) => d.name),
    );
    const project = (vars: Release["variables"]) =>
      Object.fromEntries(
        Object.entries(vars)
          .filter(([key]) => !changed.has(key))
          .map(([key, v]) => [
            key,
            {
              value: v.isSecret === true ? null : (v.value ?? null),
              isSecret: v.isSecret === true,
            },
          ]),
      );
    if (digest(project(oldVars)) !== digest(project(newVars)))
      throw new AppError(
        "POST_UPDATE_VARIABLE_CHANGED",
        "A variable outside the reviewed diff changed.",
      );
  }
  if (checkVariables && !expectedVariablesVisible(saved, r))
    throw new AppError(
      "VERIFY_FAILED",
      "Requested variable values or absence could not be verified; redeploy was not requested.",
    );
}
