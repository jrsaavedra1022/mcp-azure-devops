export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}
export function safeError(error: unknown) {
  return error instanceof AppError
    ? { code: error.code, message: error.message, status: error.status }
    : {
        code: "INTERNAL_ERROR",
        message: "Request failed. Check configuration and connectivity.",
      };
}

const startupCodes = [
  "STORE_LOCKED",
  "INVALID_CATALOG",
  "INVALID_CONFIGURATION",
  "REVIEW_SERVER_FAILED",
  "STATE_UNAVAILABLE",
] as const;
export type StartupCode = (typeof startupCodes)[number] | "STARTUP_FAILED";
export function startupCode(error: unknown): StartupCode {
  return error instanceof AppError &&
    startupCodes.some((code) => code === error.code)
    ? (error.code as StartupCode)
    : "STARTUP_FAILED";
}
