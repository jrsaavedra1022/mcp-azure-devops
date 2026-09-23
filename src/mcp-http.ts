import { createServer as createHttpServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AppError } from "./errors.js";
/** Each HTTP request owns a transport; every MCP server uses the same application services. */
export async function startMcpHttp(
  factory: () => McpServer,
  dispatch: (action: () => Promise<void>) => Promise<void> = (action) =>
    action(),
) {
  const token = randomBytes(32).toString("hex");
  let origin = "",
    closing = false;
  const tasks = new Set<Promise<void>>();
  const http = createHttpServer((req, res) => {
    const reject = (status: number) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ error: "Request rejected" }));
    };
    if (closing) {
      reject(503);
      return;
    }
    const provided = Buffer.from(req.headers.authorization ?? ""),
      expected = Buffer.from(`Bearer ${token}`);
    if (
      req.headers.host !== new URL(origin).host ||
      (req.headers.origin && req.headers.origin !== origin) ||
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      reject(403);
      return;
    }
    if (req.url !== "/mcp") {
      reject(404);
      return;
    }
    if (req.method !== "POST") {
      reject(405);
      return;
    }
    if (!req.headers["content-type"]?.startsWith("application/json")) {
      reject(415);
      return;
    }
    if (tasks.size >= 16) {
      reject(429);
      return;
    }
    const task = dispatch(async () => {
      let server: McpServer | undefined;
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const part = Buffer.from(chunk);
          size += part.length;
          if (size > 524288) {
            reject(413);
            return;
          }
          chunks.push(part);
        }
        const body: unknown = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        );
        server = factory();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch {
        if (!res.headersSent) reject(400);
        else res.end();
      } finally {
        await server?.close().catch(() => {});
      }
    }).catch(() => {
      if (!res.headersSent) reject(503);
      else res.end();
    });
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  });
  http.requestTimeout = 10000;
  http.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    http.once("error", () =>
      reject(
        new AppError("MCP_SERVER_FAILED", "Local MCP server could not start."),
      ),
    );
    http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (!address || typeof address === "string")
    throw new AppError("MCP_SERVER_FAILED", "Local MCP address unavailable.");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/mcp`,
    token,
    async close() {
      closing = true;
      await Promise.allSettled([...tasks]);
      await new Promise<void>((resolve, reject) =>
        http.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
