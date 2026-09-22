import type { Config } from "../config.js";
import { organizationSchema, projectSchema } from "../config.js";
import { AppError } from "../errors.js";
export interface ScopeInput {
  organization?: string;
  project?: string;
}
export function resolveOrganization(config: Config, input: ScopeInput) {
  const organization = input.organization ?? config.organization;
  if (!organizationSchema.safeParse(organization).success)
    throw new AppError("INVALID_SCOPE", "Provide a valid organization.");
  if (
    config.allowedOrganizations.length &&
    !config.allowedOrganizations.includes(organization!)
  )
    throw new AppError(
      "FORBIDDEN_SCOPE",
      "Organization is outside the configured allowlist.",
    );
  return organization!;
}
export function resolveScope(config: Config, input: ScopeInput) {
  const organization = resolveOrganization(config, input);
  const project = input.project ?? config.project;
  if (!projectSchema.safeParse(project).success)
    throw new AppError("INVALID_SCOPE", "Provide a valid project.");
  return { organization, project: project! };
}
