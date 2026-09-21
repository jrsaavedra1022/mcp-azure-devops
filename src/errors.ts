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
