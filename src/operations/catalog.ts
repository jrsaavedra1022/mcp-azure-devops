import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { z } from "zod";
import { organizationSchema, projectSchema } from "../config.js";
import { AppError } from "../errors.js";
const id = z.number().int().positive().max(2147483647);
const key = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,100}$/)
  .refine((s) => !["__proto__", "constructor", "prototype"].includes(s));
const change = z
  .object({
    name: key,
    scope: z.enum(["release", "environment"]),
    mustExist: z.boolean().default(true),
    values: z.record(z.string().max(8192)),
  })
  .strict();
const environmentReference = z.union([
  z
    .object({ definitionEnvironmentId: id, expectedName: z.string().min(1) })
    .strict(),
  z.object({ name: z.string().min(1) }).strict(),
]);
const targetBase = z.object({
  organization: organizationSchema,
  project: projectSchema,
  environment: environmentReference,
  selection: z
    .object({
      strategy: z.enum([
        "latestCreated",
        "latestSuccessfulDeployment",
        "explicit",
      ]),
      releaseId: id.optional(),
      sourceBranch: z.string().startsWith("refs/heads/").optional(),
    })
    .strict(),
});
export const targetSchema = z.union([
  targetBase.extend({ definitionId: id }).strict(),
  targetBase
    .extend({ definition: z.object({ name: z.string().min(1) }).strict() })
    .strict(),
]);
export const catalogSchema = z
  .object({
    schemaVersion: z.literal("1"),
    targets: z.record(key, targetSchema),
    operations: z.record(
      key,
      z
        .object({
          description: z.string().min(1).max(500),
          target: key,
          modes: z.array(key).min(1).max(20),
          variables: z.array(change).min(1).max(50),
          deployment: z
            .object({
              strategy: z.literal("environmentRedeploy"),
              downstreamPolicy: z.enum(["reject", "allow"]).default("reject"),
              redeployWhenUnchanged: z.boolean().default(false),
            })
            .strict(),
          approvals: z.enum(["external", "explicit"]).default("external"),
          planTtlMinutes: z.number().int().min(1).max(60).default(15),
          trackingTimeoutMinutes: z
            .number()
            .int()
            .min(1)
            .max(43200)
            .default(1440),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const [name, op] of Object.entries(c.operations)) {
      if (!Object.hasOwn(c.targets, op.target))
        ctx.addIssue({
          code: "custom",
          message: "Unknown target",
          path: ["operations", name, "target"],
        });
      const seen = new Set<string>();
      for (const v of op.variables) {
        const identity = v.scope + ":" + v.name.toLowerCase();
        if (
          seen.has(identity) ||
          op.modes.some((m) => !Object.hasOwn(v.values, m)) ||
          Object.keys(v.values).some((m) => !op.modes.includes(m))
        )
          ctx.addIssue({
            code: "custom",
            message: "Duplicate variable or inconsistent modes",
            path: ["operations", name, "variables"],
          });
        seen.add(identity);
      }
    }
    for (const t of Object.values(c.targets))
      if (
        (t.selection.strategy === "explicit") !==
        (t.selection.releaseId !== undefined)
      )
        ctx.addIssue({
          code: "custom",
          message: "releaseId must be provided only for explicit selection",
        });
  });
export type Catalog = z.infer<typeof catalogSchema>;
export type CatalogTarget = Catalog["targets"][string];
/** Canonical target persisted in plans. No unresolved names are allowed here. */
export type Target = Pick<
  CatalogTarget,
  "organization" | "project" | "selection"
> & {
  definitionId: number;
  environment: { definitionEnvironmentId: number; expectedName: string };
};
export type Operation = Catalog["operations"][string];
export function digest(value: unknown): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, stable(x)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}
export async function loadCatalog(path: string) {
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > 262144) throw new Error();
    const doc = parseDocument(text, { uniqueKeys: true });
    if (doc.errors.length) throw new Error();
    const catalog = catalogSchema.parse(doc.toJS({ maxAliasCount: 0 }));
    return { catalog, hash: digest(catalog) };
  } catch {
    throw new AppError(
      "INVALID_CATALOG",
      "Invalid YAML catalog. Check schema, unique keys, targets and mode mappings; aliases are not supported.",
    );
  }
}
