import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { organizationSchema, projectSchema } from "../config.js";
import { safeError } from "../errors.js";
import type { DevOpsService } from "../services/devops-service.js";
const scope = {
  organization: organizationSchema.optional(),
  project: projectSchema.optional(),
};
const id = z.number().int().positive().max(2147483647);
const page = {
  top: z.number().int().min(1).max(100).default(50),
  continuationToken: z.string().max(4096).optional(),
};
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
export async function toolResult(run: () => Promise<unknown> | unknown) {
  try {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(await run()) }],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify(safeError(e)) }],
    };
  }
}
export function registerTools(server: McpServer, service: DevOpsService) {
  server.registerTool(
    "ado_list_organizations",
    {
      description:
        "Read Azure DevOps Accounts for an explicit member UUID using the Accounts API. Requires compatible identity credentials/profile permissions; may not work with organization-scoped PATs. Results filtered by organization allowlist.",
      inputSchema: { memberId: z.string().uuid() },
      annotations,
    },
    (a) => toolResult(() => service.discoverOrganizations(a.memberId)),
  );

  server.registerTool(
    "ado_list_configured_organizations",
    {
      description:
        "List locally configured organizations; does not discover memberships or verify access.",
      inputSchema: {},
      annotations,
    },
    () => toolResult(() => service.organizations()),
  );
  server.registerTool(
    "ado_list_projects",
    {
      description: "Read one page of accessible projects.",
      inputSchema: { organization: scope.organization, ...page },
      annotations,
    },
    (a) => toolResult(() => service.projects(a, a)),
  );
  server.registerTool(
    "ado_list_release_definitions",
    {
      description: "Read one page of Classic Release definitions.",
      inputSchema: {
        ...scope,
        ...page,
        searchText: z.string().max(256).optional(),
      },
      annotations,
    },
    (a) => toolResult(() => service.definitions(a, a)),
  );
  server.registerTool(
    "ado_get_release_definition",
    {
      description:
        "Read safe Classic Release metadata without task bodies or variable values.",
      inputSchema: { ...scope, definitionId: id },
      annotations,
    },
    (a) => toolResult(() => service.definition(a, a.definitionId)),
  );
  server.registerTool(
    "ado_list_release_environments",
    {
      description:
        "Read environments within a Classic Release definition, not YAML environments.",
      inputSchema: { ...scope, definitionId: id },
      annotations,
    },
    (a) => toolResult(() => service.environments(a, a.definitionId)),
  );
  server.registerTool(
    "ado_get_release_variables",
    {
      description:
        "Read direct variables at definition scope or a selected environment. Secret or unspecified secrecy values are always hidden. Does not resolve variable groups or merge scopes.",
      inputSchema: {
        ...scope,
        definitionId: id,
        environmentId: id.optional(),
        includeValues: z.boolean().default(false),
      },
      annotations,
    },
    (a) =>
      toolResult(() =>
        service.variables(a, a.definitionId, a.environmentId, a.includeValues),
      ),
  );
}
