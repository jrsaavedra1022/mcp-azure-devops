import { z } from "zod";
import { parseDocument } from "yaml";
import { parseCatalog } from "../../src/operations/catalog.js";
import { AppError } from "../../src/errors.js";
export const operationEditSchema = z
  .object({
    operation: z.string().min(1).max(101),
    variables: z
      .array(
        z
          .object({
            name: z.string().min(1),
            scope: z.enum(["release", "environment"]),
            values: z.record(z.string().max(8192)),
          })
          .strict(),
      )
      .max(50)
      .default([]),
    downstreamPolicy: z.enum(["allow", "reject"]).optional(),
    redeployWhenUnchanged: z.boolean().optional(),
  })
  .strict();
/** A targeted proposal preserves unrelated modes, variables, operations and YAML comments. */
export function proposeOperationEdit(text: string, input: unknown) {
  const edit = operationEditSchema.parse(input),
    current = parseCatalog(text);
  const op = current.catalog.operations[edit.operation];
  if (!op)
    throw new AppError(
      "INVALID_OPERATION",
      "Select an existing operation or create one with the catalog assistant.",
    );
  const doc = parseDocument(text),
    seen = new Set<string>();
  for (const variable of edit.variables) {
    const key = variable.scope + ":" + variable.name.toLowerCase();
    if (seen.has(key))
      throw new AppError("INVALID_INPUT", "Duplicate variable edit.");
    seen.add(key);
    const index = op.variables.findIndex(
      (v) => v.name === variable.name && v.scope === variable.scope,
    );
    if (index < 0)
      throw new AppError(
        "VARIABLE_MISSING",
        "Variable and scope must match an existing catalog entry. Use the editor to add entries.",
      );
    for (const [mode, value] of Object.entries(variable.values)) {
      if (!op.modes.includes(mode))
        throw new AppError("INVALID_INPUT", "Unknown mode in operation edit.");
      doc.setIn(
        ["operations", edit.operation, "variables", index, "values", mode],
        value,
      );
    }
  }
  if (edit.downstreamPolicy !== undefined)
    doc.setIn(
      ["operations", edit.operation, "deployment", "downstreamPolicy"],
      edit.downstreamPolicy,
    );
  if (edit.redeployWhenUnchanged !== undefined)
    doc.setIn(
      ["operations", edit.operation, "deployment", "redeployWhenUnchanged"],
      edit.redeployWhenUnchanged,
    );
  const result = doc.toString();
  parseCatalog(result);
  return result;
}
