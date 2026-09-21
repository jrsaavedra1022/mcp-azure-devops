#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logging.js";
import { createServer } from "./server.js";
try {
  const config = loadConfig();
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  createLogger(config.logLevel)("server_started");
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void server.close().finally(() => process.exit(0));
    });
} catch {
  createLogger("error")("startup_failed");
  process.exitCode = 1;
}
