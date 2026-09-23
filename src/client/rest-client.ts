import type { Config } from "../config.js";
import { AppError } from "../errors.js";
import type { Logger } from "../logging.js";
export type Host = "core" | "release" | "profile";
const hosts = {
  profile: "https://app.vssps.visualstudio.com",
  core: "https://dev.azure.com",
  release: "https://vsrm.dev.azure.com",
};
export class RestClient {
  constructor(
    private config: Config,
    private log: Logger,
    private fetcher: typeof fetch = fetch,
    private sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}
  async write(method: "PUT" | "PATCH", segments: string[], body: unknown) {
    if (segments.some((s) => s === "." || s === ".."))
      throw new AppError("INVALID_INPUT", "Invalid path segment.");
    const url = new URL(
      segments.map(encodeURIComponent).join("/"),
      hosts.release + "/",
    );
    url.searchParams.set("api-version", "7.1");
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: {
          Authorization: this.config.authorization,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      await response.body?.cancel();
    } catch {
      throw new AppError(
        "WRITE_UNCERTAIN",
        "Write response was not received. Inspect Azure before retrying.",
      );
    }
    if (!response.ok)
      throw new AppError(
        "AZURE_HTTP_ERROR",
        response.status === 403
          ? "Access denied. Check resource permissions and token scopes."
          : "Azure rejected the write; inspect resource state before retrying.",
        response.status,
      );
  }
  async get(
    host: Host,
    segments: string[],
    query: Record<string, string | number | undefined> = {},
    options: { timeoutMs?: number; maxRetries?: number } = {},
  ) {
    if (segments.some((s) => s === "." || s === ".."))
      throw new AppError("INVALID_INPUT", "Invalid path segment.");
    const url = new URL(
      segments.map(encodeURIComponent).join("/"),
      hosts[host] + "/",
    );
    url.searchParams.set("api-version", "7.1");
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value));
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      let data: unknown;
      try {
        response = await this.fetcher(url, {
          method: "GET",
          redirect: "error",
          headers: {
            Authorization: this.config.authorization,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(
            Math.max(
              1,
              Math.min(
                this.config.timeoutMs,
                options.timeoutMs ?? this.config.timeoutMs,
              ),
            ),
          ),
        });
        if (response.ok) data = await response.json();
        else await response.body?.cancel();
      } catch {
        throw new AppError(
          "TRANSPORT_ERROR",
          "Azure DevOps request timed out, failed, or returned invalid JSON.",
        );
      }
      if (response.ok)
        return {
          data,
          continuationToken:
            response.headers.get("x-ms-continuationtoken") ?? undefined,
        };
      if (
        [429, 502, 503, 504].includes(response.status) &&
        attempt < (options.maxRetries ?? this.config.maxRetries)
      ) {
        const header = response.headers.get("retry-after");
        const delay =
          header === null
            ? 250 * 2 ** attempt
            : /^\d+$/.test(header)
              ? Number(header) * 1000
              : Date.parse(header) - Date.now();
        // Do not retry sooner than requested if the server asks for a long pause.
        if (Number.isFinite(delay) && delay > 30000)
          throw new AppError(
            "RATE_LIMITED",
            "Azure DevOps requested a longer wait. Retry later.",
            response.status,
          );
        await this.sleep(
          Math.max(0, Number.isFinite(delay) ? delay : 250 * 2 ** attempt),
        );
        continue;
      }
      this.log("request_failed", response.status);
      const messages: Record<number, string> = {
        401: "Authentication failed.",
        403: "Access denied. Check token scopes and resource permissions.",
        404: "Resource not found or not visible.",
        429: "Rate limit reached. Retry later.",
      };
      throw new AppError(
        "AZURE_HTTP_ERROR",
        messages[response.status] ?? "Azure DevOps request failed.",
        response.status,
      );
    }
  }
}
