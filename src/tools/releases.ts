import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ReleaseQueryService,
  listReleaseInput,
  getReleaseInput,
  latestReleaseInput,
} from "../services/release-query-service.js";
import { toolResult } from "./register.js";
export function registerReleaseTools(
  server: McpServer,
  service: ReleaseQueryService,
) {
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };
  server.registerTool(
    "ado_list_releases",
    {
      description:
        "List a page of Classic Release instances, newest first. Optional exact definition name or ID. Safe metadata only; no variables, tasks or logs.",
      inputSchema: listReleaseInput,
      annotations,
    },
    (a) => toolResult(() => service.list(a)),
  );
  server.registerTool(
    "ado_get_release",
    {
      description:
        "Read a Classic Release instance by releaseId, including stage status and safe artifact metadata. Does not read a definition or expose variables.",
      inputSchema: getReleaseInput,
      annotations,
    },
    (a) => toolResult(() => service.get(a)),
  );
  server.registerTool(
    "ado_get_latest_release",
    {
      description:
        "Get the latest active release by exact definitionName or definitionId. latestCreated is default; latestSuccessfulDeployment requires environmentName and uses successful deployment history. No operation catalog required.",
      inputSchema: latestReleaseInput,
      annotations,
    },
    (a) => toolResult(() => service.latest(a)),
  );
}
