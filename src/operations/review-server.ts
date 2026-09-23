import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AppError, safeError } from "../errors.js";
import { reviewPage, reviewScript, reviewStyle } from "./review-page.js";
import type { OperationEngine } from "./engine.js";
export async function startReviewServer(
  engine: OperationEngine,
  options: { demo?: boolean } = {},
) {
  const token = randomBytes(32).toString("hex");
  let origin = "";
  let closing = false;
  const tasks = new Set<Promise<unknown>>();
  const send = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  const body = async (req: IncomingMessage) => {
    let text = "";
    for await (const chunk of req) {
      text += String(chunk);
      if (Buffer.byteLength(text) > 8192)
        throw new AppError("INVALID_REQUEST", "Request too large.");
    }
    return JSON.parse(text || "{}") as unknown;
  };
  const server = createServer((req, res) => {
    if (closing) {
      send(res, 503, { code: "SHUTTING_DOWN" });
      return;
    }
    const task = (async () => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      );
      try {
        if (req.headers.host !== new URL(origin).host)
          throw new AppError("FORBIDDEN", "Invalid host.");
        const url = new URL(req.url ?? "/", origin);
        if (
          req.method === "GET" &&
          ["/", "/app.js", "/style.css"].includes(url.pathname)
        ) {
          res.writeHead(200, {
            "Content-Type":
              url.pathname === "/"
                ? "text/html; charset=utf-8"
                : url.pathname === "/app.js"
                  ? "application/javascript"
                  : "text/css",
          });
          res.end(
            url.pathname === "/"
              ? options.demo
                ? reviewPage.replace(
                    "CONTROL DE CAMBIOS",
                    "DEMO · DATOS SINTÉTICOS · SIN AZURE",
                  )
                : reviewPage
              : url.pathname === "/app.js"
                ? reviewScript
                : reviewStyle,
          );
          return;
        }
        const provided = Buffer.from(req.headers.authorization ?? "");
        const expected = Buffer.from("Bearer " + token);
        if (
          provided.length !== expected.length ||
          !timingSafeEqual(provided, expected)
        )
          throw new AppError(
            "FORBIDDEN",
            "Invalid local session. Reopen the link from MCP.",
          );
        if (req.headers.origin && req.headers.origin !== origin)
          throw new AppError("FORBIDDEN", "Invalid origin.");
        if (req.method === "GET" && url.pathname === "/api/executions") {
          send(res, 200, await engine.list());
          return;
        }
        const match =
          /^\/api\/executions\/([a-f0-9-]{36})(?:\/(apply|cancel|rollback|approval|recover))?$/.exec(
            url.pathname,
          );
        if (!match) throw new AppError("NOT_FOUND", "Unknown endpoint.");
        const id = match[1]!;
        if (req.method === "GET" && !match[2]) {
          send(res, 200, {
            ...(await engine.get(id)),
            capabilities: engine.reviewCapabilities(),
          });
          return;
        }
        if (
          req.method !== "POST" ||
          req.headers.origin !== origin ||
          req.headers["content-type"] !== "application/json"
        )
          throw new AppError("FORBIDDEN", "Same-origin JSON request required.");
        const data = await body(req);
        switch (match[2]) {
          case "apply": {
            send(res, 200, await engine.applyFromReview(id));
            return;
          }
          case "cancel":
            await engine.cancel(id);
            break;
          case "rollback":
            send(res, 200, await engine.planRollback(id));
            return;
          case "recover":
            await engine.acknowledgeRecovery(id);
            break;
          case "approval": {
            const a = z
              .object({
                approvalId: z.number().int().positive(),
                decision: z.enum(["approved", "rejected"]),
                comment: z.string().trim().min(1).max(1000),
              })
              .strict()
              .parse(data);
            await engine.decideFromReview(
              id,
              a.approvalId,
              a.decision,
              a.comment,
            );
            break;
          }
          default:
            throw new AppError("NOT_FOUND", "Unknown action.");
        }
        send(res, 200, { ok: true });
      } catch (e) {
        send(
          res,
          e instanceof AppError && e.code === "FORBIDDEN" ? 403 : 400,
          safeError(e),
        );
      }
    })();
    tasks.add(task);
    void task.finally(() => tasks.delete(task)).catch(() => {});
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", () =>
      reject(
        new AppError(
          "REVIEW_SERVER_FAILED",
          "Local review server could not start.",
        ),
      ),
    );
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Invalid address");
  origin = "http://127.0.0.1:" + address.port;
  return {
    url: (id?: string) => origin + "/#token=" + token + (id ? "&id=" + id : ""),
    origin,
    close: async () => {
      closing = true;
      await Promise.allSettled([...tasks]);
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
