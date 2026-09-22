import { z } from "zod";
import { RestClient } from "../client/rest-client.js";
import { AppError } from "../errors.js";
import { resolveEnvironmentTarget } from "./target-resolver.js";
import type { CatalogTarget, Target } from "./catalog.js";
const variable = z
  .object({
    value: z.string().nullable().optional(),
    isSecret: z.boolean().optional(),
    allowOverride: z.boolean().optional(),
  })
  .passthrough();
const condition = z
  .object({
    name: z.string(),
    conditionType: z.string(),
    value: z.string().optional(),
  })
  .passthrough();
const step = z
  .object({
    attempt: z.number(),
    status: z.string().optional(),
    deploymentId: z.number().optional(),
  })
  .passthrough();
const environment = z
  .object({
    id: z.number(),
    definitionEnvironmentId: z.number(),
    name: z.string(),
    status: z.string(),
    variables: z.record(variable).default({}),
    conditions: z.array(condition),
    environmentTriggers: z.array(z.unknown()).default([]),
    deploySteps: z.array(step).default([]),
  })
  .passthrough();
export const releaseSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    status: z.string(),
    releaseDefinition: z.object({ id: z.number() }).passthrough(),
    variables: z.record(variable).default({}),
    environments: z.array(environment),
    artifacts: z.array(z.unknown()),
  })
  .passthrough();
export type Release = z.infer<typeof releaseSchema>;
export type Environment = Release["environments"][number];
export function matchesBranch(release: Release, branch: string): boolean {
  return release.artifacts.some((a) => {
    const result = z
      .object({
        definitionReference: z.object({ branch: z.object({ id: z.string() }) }),
      })
      .safeParse(a);
    return (
      result.success && result.data.definitionReference.branch.id === branch
    );
  });
}
export interface Approval {
  id: number;
  status: string;
  attempt: number;
  approvalType: string;
  approver: string;
}
export interface ReleaseGateway {
  resolveTarget(t: CatalogTarget): Promise<Target>;
  select(t: Target): Promise<Release>;
  get(t: Target, id: number): Promise<Release>;
  update(t: Target, release: Release): Promise<void>;
  deploy(t: Target, id: number, env: number, comment: string): Promise<void>;
  approvals(
    t: Target,
    id: number,
    env: number,
    attempt: number,
  ): Promise<Approval[]>;
  decide(
    t: Target,
    approval: number,
    decision: "approved" | "rejected",
    comment: string,
  ): Promise<void>;
}
export class AzureReleaseGateway implements ReleaseGateway {
  constructor(private client: RestClient) {}
  private path(t: Pick<Target, "organization" | "project">, ...tail: string[]) {
    return [t.organization, t.project, "_apis", "release", ...tail];
  }
  async resolveTarget(t: CatalogTarget): Promise<Target> {
    let definitionId: number;
    if ("definitionId" in t) {
      definitionId = t.definitionId;
    } else {
      const ids = new Set<number>();
      let token: string | undefined;
      for (let page = 0; ; page++) {
        if (page === 20)
          throw new AppError(
            "SEARCH_LIMIT",
            "Definition search limit exceeded. Use explicit IDs.",
          );
        const response = await this.client.get(
          "release",
          this.path(t, "definitions"),
          {
            searchText: t.definition.name,
            isExactNameMatch: "true",
            isDeleted: "false",
            $top: 100,
            continuationToken: token,
          },
        );
        const rows = z
          .object({
            value: z.array(
              z.object({ id: z.number().int().positive(), name: z.string() }),
            ),
          })
          .parse(response.data).value;
        for (const row of rows)
          if (row.name === t.definition.name) ids.add(row.id);
        if (ids.size > 1)
          throw new AppError(
            "AMBIGUOUS_RELEASE_DEFINITION",
            `Multiple release definitions matched "${t.definition.name}".`,
          );
        token = response.continuationToken;
        if (!token) break;
      }
      if (!ids.size)
        throw new AppError(
          "RELEASE_DEFINITION_NOT_FOUND",
          `Release definition "${t.definition.name}" was not found.`,
        );
      definitionId = [...ids][0]!;
    }
    // Preserve the legacy ID-only path without extra requests.
    if ("definitionId" in t && "definitionEnvironmentId" in t.environment) {
      return {
        organization: t.organization,
        project: t.project,
        selection: { ...t.selection },
        definitionId,
        environment: { ...t.environment },
      };
    }
    const definition = z
      .object({
        id: z.number().int().positive(),
        name: z.string(),
        environments: z.array(
          z.object({ id: z.number().int().positive(), name: z.string() }),
        ),
      })
      .parse(
        (
          await this.client.get(
            "release",
            this.path(t, "definitions", String(definitionId)),
          )
        ).data,
      );
    if (
      definition.id !== definitionId ||
      ("definition" in t && definition.name !== t.definition.name)
    ) {
      throw new AppError(
        "TARGET_CHANGED",
        "Release definition identity changed during resolution. Create a new plan.",
      );
    }
    return resolveEnvironmentTarget(t, definition);
  }
  async get(t: Target, id: number) {
    return releaseSchema.parse(
      (await this.client.get("release", this.path(t, "releases", String(id))))
        .data,
    );
  }
  async select(t: Target) {
    if (t.selection.strategy === "explicit")
      return this.get(t, t.selection.releaseId!);
    if (t.selection.strategy === "latestCreated") {
      const r = await this.client.get("release", this.path(t, "releases"), {
        definitionId: t.definitionId,
        statusFilter: "active",
        queryOrder: "descending",
        $top: 1,
        sourceBranchFilter: t.selection.sourceBranch,
      });
      const items = z
        .object({ value: z.array(z.object({ id: z.number() })) })
        .parse(r.data).value;
      if (!items[0])
        throw new AppError("NOT_FOUND", "No matching active release.");
      return this.get(t, items[0].id);
    }
    // Deployment history, not release creation time. Fail if bounded history is exhausted.
    let token: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.client.get("release", this.path(t, "deployments"), {
        definitionId: t.definitionId,
        definitionEnvironmentId: t.environment.definitionEnvironmentId,
        deploymentStatus: "succeeded",
        queryOrder: "descending",
        latestAttemptsOnly: "false",
        $top: 50,
        continuationToken: token,
      });
      const rows = z
        .object({
          value: z.array(z.object({ release: z.object({ id: z.number() }) })),
        })
        .parse(r.data).value;
      for (const row of rows) {
        const release = await this.get(t, row.release.id);
        if (release.status !== "active") continue;
        if (
          t.selection.sourceBranch &&
          !matchesBranch(release, t.selection.sourceBranch)
        )
          continue;
        return release;
      }
      token = r.continuationToken;
      if (!token)
        throw new AppError(
          "NOT_FOUND",
          "No active release with a matching successful deployment.",
        );
    }
    throw new AppError(
      "SEARCH_LIMIT",
      "Deployment history limit exceeded. Select an explicit release.",
    );
  }
  async update(t: Target, release: Release) {
    await this.client.write(
      "PUT",
      this.path(t, "releases", String(release.id)),
      release,
    );
  }
  async deploy(t: Target, id: number, env: number, comment: string) {
    await this.client.write(
      "PATCH",
      this.path(t, "releases", String(id), "environments", String(env)),
      { status: "inProgress", comment },
    );
  }
  async approvals(t: Target, id: number, env: number, attempt: number) {
    const result: Approval[] = [];
    let token: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.client.get("release", this.path(t, "approvals"), {
        releaseIdsFilter: String(id),
        statusFilter: "pending",
        includeMyGroupApprovals: "true",
        top: 100,
        continuationToken: token,
      });
      const rows = z
        .object({
          value: z.array(
            z.object({
              id: z.number(),
              status: z.string(),
              attempt: z.number(),
              approvalType: z.string(),
              releaseEnvironment: z.object({ id: z.number() }),
              approver: z
                .object({ displayName: z.string().optional() })
                .optional(),
            }),
          ),
        })
        .parse(r.data).value;
      result.push(
        ...rows
          .filter(
            (a) => a.releaseEnvironment.id === env && a.attempt === attempt,
          )
          .map((a) => ({
            id: a.id,
            status: a.status,
            attempt: a.attempt,
            approvalType: a.approvalType,
            approver: a.approver?.displayName ?? "Azure approver",
          })),
      );
      token = r.continuationToken;
      if (!token) return result;
    }
    throw new AppError(
      "SEARCH_LIMIT",
      "Approval pagination limit reached. Inspect in Azure.",
    );
  }
  async decide(
    t: Target,
    id: number,
    status: "approved" | "rejected",
    comments: string,
  ) {
    await this.client.write("PATCH", this.path(t, "approvals", String(id)), {
      status,
      comments,
    });
  }
}
