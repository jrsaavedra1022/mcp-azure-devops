import { z } from "zod";
import type { Config } from "../config.js";
import { organizationSchema, projectSchema } from "../config.js";
import type {
  Definition,
  DevOpsReader,
  PageInput,
} from "../adapters/azure-devops.js";
import { AppError } from "../errors.js";
export interface Scope {
  organization?: string;
  project?: string;
}
export class DevOpsService {
  constructor(
    private config: Config,
    private reader: DevOpsReader,
  ) {}
  async discoverOrganizations(memberId: string) {
    if (!z.string().uuid().safeParse(memberId).success)
      throw new AppError("INVALID_INPUT", "memberId must be a UUID.");
    const items = await this.reader.organizations(memberId);
    return {
      source: "azure-devops-accounts",
      items: items.filter(
        (a) =>
          !this.config.allowedOrganizations.length ||
          this.config.allowedOrganizations.includes(a.name),
      ),
    };
  }
  organizations() {
    return {
      source: "configuration",
      verified: false,
      items: [
        ...new Set([
          ...this.config.allowedOrganizations,
          ...(this.config.organization ? [this.config.organization] : []),
        ]),
      ]
        .filter(
          (s) =>
            !this.config.allowedOrganizations.length ||
            this.config.allowedOrganizations.includes(s),
        )
        .map((name) => ({ name })),
    };
  }
  private org(scope: Scope) {
    const org = scope.organization ?? this.config.organization;
    if (!organizationSchema.safeParse(org).success)
      throw new AppError("INVALID_SCOPE", "Provide a valid organization.");
    if (
      this.config.allowedOrganizations.length &&
      !this.config.allowedOrganizations.includes(org!)
    )
      throw new AppError(
        "FORBIDDEN_SCOPE",
        "Organization is outside the configured allowlist.",
      );
    return org!;
  }
  private scope(scope: Scope) {
    const org = this.org(scope);
    const project = scope.project ?? this.config.project;
    if (!projectSchema.safeParse(project).success)
      throw new AppError("INVALID_SCOPE", "Provide a valid project.");
    return { org, project: project! };
  }
  projects(scope: Scope, page: PageInput) {
    return this.reader.projects(this.org(scope), page);
  }
  definitions(scope: Scope, page: PageInput & { searchText?: string }) {
    const s = this.scope(scope);
    return this.reader.definitions(s.org, s.project, page);
  }
  private read(scope: Scope, id: number) {
    if (!Number.isInteger(id) || id < 1 || id > 2147483647)
      throw new AppError(
        "INVALID_INPUT",
        "definitionId must be a positive Int32.",
      );
    const s = this.scope(scope);
    return this.reader.definition(s.org, s.project, id);
  }
  async definition(scope: Scope, id: number) {
    const d = await this.read(scope, id);
    return {
      id: d.id,
      name: d.name,
      revision: d.revision,
      path: d.path,
      environments: d.environments.map((e) => ({
        id: e.id,
        name: e.name,
        rank: e.rank,
      })),
      variableGroups: d.variableGroups,
    };
  }
  async environments(scope: Scope, id: number) {
    return (await this.definition(scope, id)).environments;
  }
  async variables(
    scope: Scope,
    id: number,
    environmentId?: number,
    includeValues = false,
  ) {
    const d = await this.read(scope, id);
    const selected =
      environmentId === undefined
        ? d
        : d.environments.find((e) => e.id === environmentId);
    if (!selected)
      throw new AppError(
        "NOT_FOUND",
        "Environment not found in this definition.",
      );
    return {
      scope: environmentId === undefined ? "definition" : "environment",
      environmentId,
      variableGroups: selected.variableGroups,
      variables: Object.entries(selected.variables).map(
        ([name, v]: [string, Definition["variables"][string]]) => ({
          name,
          isSecret: v.isSecret ?? null,
          allowOverride: v.allowOverride ?? false,
          ...(includeValues && v.isSecret === false
            ? { value: v.value ?? null }
            : {}),
          valueHidden: !includeValues || v.isSecret !== false,
        }),
      ),
    };
  }
}
