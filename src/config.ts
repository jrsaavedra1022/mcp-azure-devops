import { z } from "zod";
export const organizationSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,49}$/);
export const projectSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((v) => v !== "." && v !== ".." && !/[\\/\x00-\x1f]/.test(v));
const optional = (v: unknown) => (v === "" ? undefined : v);
const schema = z
  .object({
    AZDO_PAT: z.preprocess(optional, z.string().min(1).optional()),
    AZDO_BEARER_TOKEN: z.preprocess(optional, z.string().min(1).optional()),
    AZDO_ORGANIZATION: z.preprocess(optional, organizationSchema.optional()),
    AZDO_PROJECT: z.preprocess(optional, projectSchema.optional()),
    AZDO_ALLOWED_ORGANIZATIONS: z.string().default(""),
    AZDO_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(120000)
      .default(15000),
    AZDO_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(2),
    AZDO_LOG_LEVEL: z.enum(["silent", "error", "info"]).default("error"),
  })
  .refine((v) => Boolean(v.AZDO_PAT) !== Boolean(v.AZDO_BEARER_TOKEN));
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      "Invalid configuration. Check credential exclusivity and environment settings.",
    );
  const v = parsed.data;
  const allowedOrganizations = v.AZDO_ALLOWED_ORGANIZATIONS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    allowedOrganizations.some((s) => !organizationSchema.safeParse(s).success)
  )
    throw new Error("Invalid organization allowlist.");
  return {
    organization: v.AZDO_ORGANIZATION,
    project: v.AZDO_PROJECT,
    allowedOrganizations,
    authorization: v.AZDO_PAT
      ? `Basic ${Buffer.from(`:${v.AZDO_PAT}`).toString("base64")}`
      : `Bearer ${v.AZDO_BEARER_TOKEN}`,
    timeoutMs: v.AZDO_TIMEOUT_MS,
    maxRetries: v.AZDO_MAX_RETRIES,
    logLevel: v.AZDO_LOG_LEVEL,
  };
}
export type Config = ReturnType<typeof loadConfig>;
