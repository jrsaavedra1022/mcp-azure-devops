import { z } from "zod";
// Allowlist every field at every nesting level. Never forward raw release/task/variable data.
const reference = z.object({
  id: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
});
export const artifactMetadataSchema = z.object({
  alias: z.string().optional(),
  type: z.string().optional(),
  definitionReference: z
    .object({
      version: reference.optional(),
      branch: reference.optional(),
      definition: reference.optional(),
      project: reference.optional(),
    })
    .optional(),
});
export const releaseMetadataSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  createdOn: z.string().optional(),
  modifiedOn: z.string().optional(),
  releaseDefinition: z.object({ id: z.number(), name: z.string().optional() }),
  environments: z
    .array(
      z.object({
        id: z.number(),
        definitionEnvironmentId: z.number().optional(),
        name: z.string(),
        status: z.string(),
        deploySteps: z
          .array(
            z.object({ attempt: z.number(), status: z.string().optional() }),
          )
          .optional(),
      }),
    )
    .optional(),
  artifacts: z.array(artifactMetadataSchema).optional(),
});
export function safeReleaseMetadata(input: unknown) {
  const release = releaseMetadataSchema.parse(input);
  return {
    ...release,
    environments: release.environments?.map(({ deploySteps, ...env }) => ({
      ...env,
      latestAttempt: deploySteps?.length
        ? deploySteps.reduce((a, b) => (a.attempt >= b.attempt ? a : b))
        : undefined,
    })),
  };
}
