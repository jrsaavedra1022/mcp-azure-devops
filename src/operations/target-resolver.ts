import type { CatalogTarget, Target } from "./catalog.js";
import { AppError } from "../errors.js";

/** Convert a definition snapshot to an ID-bound target; shared by live and demo gateways. */
export function resolveEnvironmentTarget(
  t: CatalogTarget,
  definition: {
    id: number;
    name: string;
    environments: { id: number; name: string }[];
  },
): Target {
  let environment: Target["environment"];
  if ("definitionEnvironmentId" in t.environment) {
    environment = { ...t.environment };
  } else {
    const name = t.environment.name;
    const matches = definition.environments.filter((e) => e.name === name);
    if (!matches.length)
      throw new AppError(
        "ENVIRONMENT_NOT_FOUND",
        `Environment "${name}" was not found in release definition "${definition.name}".`,
      );
    if (matches.length > 1)
      throw new AppError(
        "AMBIGUOUS_ENVIRONMENT",
        `Multiple environments matched "${name}".`,
      );
    environment = {
      definitionEnvironmentId: matches[0]!.id,
      expectedName: name,
    };
  }
  return {
    organization: t.organization,
    project: t.project,
    selection: { ...t.selection },
    definitionId: definition.id,
    environment,
  };
}
