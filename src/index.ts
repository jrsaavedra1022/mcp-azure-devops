#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startOperations } from "./operations/runtime.js";
import { startupCode } from "./errors.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logging.js";
import { createServer } from "./server.js";
let operations: Awaited<ReturnType<typeof startOperations>>;
try {
  const config = loadConfig();
  operations = await startOperations(config);
  const server = createServer(config, undefined, operations);
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      await operations?.close();
    })());
  server.server.onclose = () => {
    void close().finally(() => process.exit(0));
  };
  await server.connect(new StdioServerTransport());
  createLogger(config.logLevel)("server_started");
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void server
        .close()
        .then(close)
        .finally(() => process.exit(0));
    });
} catch (error) {
  await operations?.close().catch(() => {});
  createLogger("error")("startup_failed", undefined, startupCode(error));
  process.exitCode = 1;
}
