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
export function createServer(config: Config, reader?: DevOpsReader) {
  const server = new McpServer({
    name: "azure-devops-classic-mcp",
    version: "0.1.0",
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
  return server;
}
