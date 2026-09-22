import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OperationsRuntime } from "../operations/runtime.js";
import { toolResult } from "./register.js";
export function registerOperationTools(
  server: McpServer,
  runtime: OperationsRuntime,
) {
  const read = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };
  const local = { ...read, readOnlyHint: false, idempotentHint: false };
  server.registerTool(
    "ado_list_operations",
    {
      description: "List configured recurring operations and allowed modes.",
      inputSchema: {},
      annotations: read,
    },
    () => toolResult(() => runtime.engine.listOperations()),
  );
  server.registerTool(
    "ado_plan_operation",
    {
      description:
        "Prepare a pinned Classic Release plan. No Azure writes. Open reviewUrl for mandatory local review; MCP cannot apply it directly.",
      inputSchema: { operation: z.string().min(1), mode: z.string().min(1) },
      annotations: local,
    },
    (a) =>
      toolResult(async () => {
        const r = await runtime.engine.plan(a.operation, a.mode);
        return {
          id: r.id,
          state: r.state,
          releaseId: r.releaseId,
          releaseName: r.releaseName,
          environment: r.environmentName,
          changeCount: r.changes.length,
          reviewUrl: runtime.review.url(r.id),
        };
      }),
  );
  server.registerTool(
    "ado_get_operation_status",
    {
      description:
        "Read persistent execution status and events. Variable values remain in local review UI.",
      inputSchema: { id: z.string().uuid() },
      annotations: read,
    },
    (a) =>
      toolResult(async () => {
        const r = await runtime.engine.get(a.id);
        return {
          id: r.id,
          state: r.state,
          events: r.events,
          error: r.error,
          approvals: r.approvals,
          reviewUrl: runtime.review.url(r.id),
        };
      }),
  );
  server.registerTool(
    "ado_list_operation_executions",
    {
      description: "List local execution history.",
      inputSchema: {},
      annotations: read,
    },
    () => toolResult(() => runtime.engine.list()),
  );
  server.registerTool(
    "ado_plan_operation_rollback",
    {
      description:
        "Prepare restoration of the original values on the original release. Requires local review before execution.",
      inputSchema: { id: z.string().uuid() },
      annotations: local,
    },
    (a) =>
      toolResult(async () => {
        const r = await runtime.engine.planRollback(a.id);
        return {
          id: r.id,
          state: r.state,
          reviewUrl: runtime.review.url(r.id),
        };
      }),
  );
  server.registerTool(
    "ado_open_operation_review",
    {
      description:
        "Get authenticated local review URL. Treat it as a local session capability; do not publish it.",
      inputSchema: { id: z.string().uuid().optional() },
      annotations: read,
    },
    (a) =>
      toolResult(async () => {
        if (a.id) await runtime.engine.get(a.id);
        return { reviewUrl: runtime.review.url(a.id) };
      }),
  );
}
