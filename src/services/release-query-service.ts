import { z } from "zod";
import type { Config } from "../config.js";
import { organizationSchema, projectSchema } from "../config.js";
import type {
  AzureReleaseGateway,
  DefinitionReference,
} from "../operations/gateway.js";
import { AppError } from "../errors.js";
import { safeReleaseMetadata } from "./release-metadata.js";
import { resolveScope } from "./scope.js";
const id = z.number().int().positive().max(2147483647);
const scope = {
  organization: organizationSchema.optional(),
  project: projectSchema.optional(),
};
const definition = {
  definitionId: id.optional(),
  definitionName: z.string().min(1).max(256).optional(),
};
const branch = z.string().startsWith("refs/heads/").optional();
export const listReleaseInput = z
  .object({
    ...scope,
    ...definition,
    status: z.enum(["active", "draft", "abandoned"]).optional(),
    top: z.number().int().min(1).max(100).default(50),
    continuationToken: z.string().max(4096).optional(),
    sourceBranch: branch,
  })
  .strict()
  .refine(
    (a) => !(a.definitionId !== undefined && a.definitionName !== undefined),
    "Use only one definition reference.",
  );
export const getReleaseInput = z.object({ ...scope, releaseId: id }).strict();
export const latestReleaseInput = z
  .object({
    ...scope,
    ...definition,
    strategy: z
      .enum(["latestCreated", "latestSuccessfulDeployment"])
      .default("latestCreated"),
    environmentName: z.string().min(1).optional(),
    sourceBranch: branch,
  })
  .strict()
  .refine(
    (a) => (a.definitionId !== undefined) !== (a.definitionName !== undefined),
    "Provide exactly one definition reference.",
  )
  .refine(
    (a) =>
      a.strategy !== "latestSuccessfulDeployment" ||
      a.environmentName !== undefined,
    "environmentName is required for latestSuccessfulDeployment.",
  );
function parse<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  input: unknown,
): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new AppError(
      "INVALID_INPUT",
      result.error.issues.map((i) => i.message).join(" "),
    );
  return result.data;
}
export class ReleaseQueryService {
  constructor(
    private config: Config,
    private gateway: Pick<
      AzureReleaseGateway,
      "resolveDefinition" | "resolveTarget" | "list" | "getMetadata" | "select"
    >,
  ) {}
  async list(input: unknown) {
    const a = parse(listReleaseInput, input),
      s = resolveScope(this.config, a);
    const definitionId =
      a.definitionName !== undefined
        ? await this.gateway.resolveDefinition(s, {
            definitionName: a.definitionName,
          })
        : a.definitionId;
    return this.gateway.list(s, { ...a, definitionId });
  }
  async get(input: unknown) {
    const a = parse(getReleaseInput, input);
    return this.gateway.getMetadata(resolveScope(this.config, a), a.releaseId);
  }
  async latest(input: unknown) {
    const a = parse(latestReleaseInput, input),
      s = resolveScope(this.config, a);
    const reference: DefinitionReference =
      a.definitionId !== undefined
        ? { definitionId: a.definitionId }
        : { definitionName: a.definitionName! };
    const selection = { strategy: a.strategy, sourceBranch: a.sourceBranch };
    const target =
      a.environmentName !== undefined
        ? await this.gateway.resolveTarget({
            ...s,
            ...("definitionId" in reference
              ? reference
              : { definition: { name: reference.definitionName } }),
            environment: { name: a.environmentName },
            selection,
          })
        : {
            ...s,
            definitionId: await this.gateway.resolveDefinition(s, reference),
            selection,
          };
    const release = await this.gateway.select(target);
    if (
      release.status !== "active" ||
      release.releaseDefinition.id !== target.definitionId
    )
      throw new AppError(
        "INVALID_TARGET",
        "Release must be active and belong to the requested definition.",
      );
    return safeReleaseMetadata(release);
  }
}
