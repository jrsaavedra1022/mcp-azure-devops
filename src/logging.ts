import { AppError, startupCode, type StartupCode } from "./errors.js";
import type { Config } from "./config.js";
// Deliberately accepts no arbitrary payloads, URLs, headers or exception messages.
export function createLogger(level: Config["logLevel"]) {
  return (
    event: "request_failed" | "server_started" | "startup_failed",
    status?: number,
    code?: StartupCode,
  ) => {
    if (level === "silent" || (level === "error" && event === "server_started"))
      return;
    process.stderr.write(
      JSON.stringify({
        time: new Date().toISOString(),
        event,
        status,
        code:
          code === undefined ? undefined : startupCode(new AppError(code, "")),
      }) + "\n",
    );
  };
}
export type Logger = ReturnType<typeof createLogger>;
