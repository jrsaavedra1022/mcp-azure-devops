import { registerReleaseTools } from "./tools/releases.js";
import { ReleaseQueryService } from "./services/release-query-service.js";
import { AzureReleaseGateway } from "./operations/gateway.js";
import { registerOperationTools } from "./tools/operations.js";
import type { OperationsRuntime } from "./operations/runtime.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { createLogger } from "./logging.js";
import { RestClient } from "./client/rest-client.js";
import {
  AzureDevOpsAdapter,
  type DevOpsReader,
} from "./adapters/azure-devops.js";
import { DevOpsService } from "./services/devops-service.js";
import { registerTools } from "./tools/register.js";
export function createServer(
  config: Config,
  reader?: DevOpsReader,
  operations?: OperationsRuntime,
  releaseGateway?: AzureReleaseGateway,
) {
  const server = new McpServer({
    name: "azure-devops-classic-mcp",
    version: "0.2.0",
  });
  registerTools(
    server,
    new DevOpsService(
      config,
      reader ??
        new AzureDevOpsAdapter(
          new RestClient(config, createLogger(config.logLevel)),
        ),
    ),
  );
  registerReleaseTools(
    server,
    new ReleaseQueryService(
      config,
      releaseGateway ??
        new AzureReleaseGateway(
          new RestClient(config, createLogger(config.logLevel)),
        ),
    ),
  );
  if (operations) registerOperationTools(server, operations);
  return server;
}
