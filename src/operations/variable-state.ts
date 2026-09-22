import { digest } from "./catalog.js";
import type { Release } from "./gateway.js";
type Variable = Release["variables"][string];
function normalize(variable: Variable | null): Variable | null {
  if (
    variable &&
    variable.isSecret === undefined &&
    typeof variable.value === "string"
  )
    return { ...variable, isSecret: false };
  return variable;
}
/** Representation-only normalization for comparisons, never for requests or stored diffs. */
export function variableDigest(variable: Variable | null): string {
  return digest(normalize(variable));
}
export function normalizeVariables(
  variables: Record<string, Variable>,
): Record<string, Variable> {
  return Object.fromEntries(
    Object.entries(variables).map(([name, variable]) => [
      name,
      normalize(variable)!,
    ]),
  );
}
