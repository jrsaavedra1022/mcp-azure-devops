import type { Config } from "./config.js";
// Deliberately accepts no arbitrary payloads, URLs, headers or exception messages.
export function createLogger(level: Config["logLevel"]) {
  return (
    event: "request_failed" | "server_started" | "startup_failed",
    status?: number,
  ) => {
    if (level === "silent" || (level === "error" && event === "server_started"))
      return;
    process.stderr.write(
      JSON.stringify({ time: new Date().toISOString(), event, status }) + "\n",
    );
  };
}
export type Logger = ReturnType<typeof createLogger>;
