import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMcpHttp } from "../src/mcp-http.js";
test("authenticated HTTP MCP works with the official client, shares services without sharing transports", async () => {
  let calls = 0;
  const endpoint = await startMcpHttp(() => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    server.registerTool(
      "read_shared",
      { inputSchema: {}, annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: "text", text: String(++calls) }] }),
    );
    return server;
  });
  const clients: Client[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const client = new Client({ name: "test-client", version: "1.0.0" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(endpoint.url), {
          requestInit: {
            headers: { Authorization: `Bearer ${endpoint.token}` },
          },
        }),
      );
      assert.equal((await client.listTools()).tools.length, 1);
      const result = await client.callTool({
        name: "read_shared",
        arguments: {},
      });
      assert.equal(
        (result.content as { text: string }[])[0]!.text,
        String(i + 1),
      );
    }
    assert.equal((await fetch(endpoint.url, { method: "POST" })).status, 403);
    const headers = {
      Authorization: `Bearer ${endpoint.token}`,
      "Content-Type": "application/json",
    };
    assert.equal(
      (
        await fetch(endpoint.url, {
          method: "POST",
          headers: { ...headers, Origin: "https://example.invalid" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal((await fetch(endpoint.url, { headers })).status, 405);
    assert.equal(
      (
        await fetch(endpoint.url, {
          method: "POST",
          headers,
          body: '{"x":"' + "a".repeat(524288) + '"}',
        })
      ).status,
      413,
    );
    assert.equal(
      (await fetch(endpoint.url, { method: "POST", headers, body: "not-json" }))
        .status,
      400,
    );
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await endpoint.close();
  }
});
test("HTTP shutdown waits for admitted requests and never replays tools", async () => {
  let entered!: () => void,
    finish!: () => void,
    calls = 0;
  const start = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (finish = r));
  const endpoint = await startMcpHttp(() => {
    const s = new McpServer({ name: "test", version: "1" });
    s.registerTool("slow", { inputSchema: {} }, async () => {
      calls++;
      entered();
      await gate;
      return { content: [{ type: "text", text: "done" }] };
    });
    return s;
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
    }),
  );
  const call = client.callTool({ name: "slow", arguments: {} });
  await start;
  let closed = false;
  const closing = endpoint.close().then(() => {
    closed = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(closed, false);
  finish();
  await call;
  await client.close();
  await closing;
  assert.equal(calls, 1);
});
