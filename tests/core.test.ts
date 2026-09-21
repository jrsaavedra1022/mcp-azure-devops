import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { RestClient } from "../src/client/rest-client.js";
import {
  AzureDevOpsAdapter,
  type DevOpsReader,
} from "../src/adapters/azure-devops.js";
import { DevOpsService } from "../src/services/devops-service.js";
import { toolResult } from "../src/tools/register.js";
import { createServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
const config = () =>
  loadConfig({
    AZDO_PAT: "test-only-token",
    AZDO_ORGANIZATION: "example",
    AZDO_PROJECT: "Project Á",
  });
const fixture = {
  id: 7,
  name: "Example",
  revision: 2,
  variables: {
    secret: { value: "NEVER_OUTPUT", isSecret: true },
    plain: { value: "hello", isSecret: false },
    unknown: { value: "HIDE_UNKNOWN" },
  },
  variableGroups: [4],
  environments: [
    {
      id: 9,
      name: "DEV",
      variables: { local: { value: "dev", isSecret: false } },
      variableGroups: [],
    },
  ],
};
const reader: DevOpsReader = {
  organizations: async () => [
    { id: "1", name: "allowed" },
    { id: "2", name: "other" },
  ],
  projects: async () => ({ items: [] }),
  definitions: async () => ({ items: [] }),
  definition: async () => fixture,
};
test("configuration rejects absent/conflicting credentials and invalid settings", () => {
  assert.throws(() => loadConfig({}));
  assert.throws(
    () => loadConfig({ AZDO_PAT: "SECRET", AZDO_BEARER_TOKEN: "SECRET" }),
    (e) => !String(e).includes("SECRET"),
  );
  assert.throws(() => loadConfig({ AZDO_PAT: "test", AZDO_TIMEOUT_MS: "NaN" }));
  assert.throws(() =>
    loadConfig({ AZDO_PAT: "test", AZDO_ALLOWED_ORGANIZATIONS: "../bad" }),
  );
});
test("GET encodes projects and pagination, fixes host, and strips extra fields", async () => {
  let observed: URL | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    observed = new URL(String(input));
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      config().authorization,
    );
    return new Response(
      JSON.stringify({
        value: [{ id: 7, name: "test", variables: fixture.variables }],
      }),
      { headers: { "x-ms-continuationtoken": "next & one" } },
    );
  };
  const result = await new AzureDevOpsAdapter(
    new RestClient(config(), () => {}, fetcher),
  ).definitions("example", "Project Á", { top: 2, continuationToken: "a&b" });
  assert.equal(observed?.hostname, "vsrm.dev.azure.com");
  assert.match(observed!.pathname, /Project%20%C3%81/);
  assert.equal(observed?.searchParams.get("continuationToken"), "a&b");
  assert.equal(observed?.searchParams.get("$top"), "2");
  assert.deepEqual(result, {
    items: [{ id: 7, name: "test" }],
    continuationToken: "next & one",
  });
});
test("429 retries honor retry-after and are bounded", async () => {
  let calls = 0;
  const delays: number[] = [];
  const fetcher: typeof fetch = async () => {
    calls++;
    return calls < 3
      ? new Response("private", {
          status: 429,
          headers: { "retry-after": "1" },
        })
      : new Response("{}");
  };
  await new RestClient(
    config(),
    () => {},
    fetcher,
    async (ms) => {
      delays.push(ms);
    },
  ).get("core", ["example"]);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 1000]);
  calls = 0;
  const always: typeof fetch = async () => {
    calls++;
    return new Response("", { status: 503 });
  };
  await assert.rejects(
    new RestClient(
      config(),
      () => {},
      always,
      async () => {},
    ).get("core", ["example"]),
    /request failed/,
  );
  assert.equal(calls, 3);
});
test("errors do not expose upstream bodies or credentials; auth errors are not retried", async () => {
  for (const status of [401, 403, 404, 500]) {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return new Response("UPSTREAM_SECRET", { status });
    };
    const result = await toolResult(() =>
      new RestClient(config(), () => {}, fetcher).get("core", ["example"]),
    );
    assert.equal(result.isError, true);
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(result).includes("UPSTREAM_SECRET"));
  }
  const fetcher: typeof fetch = async () => {
    throw new Error("test-only-token");
  };
  assert.ok(
    !JSON.stringify(
      await toolResult(() =>
        new RestClient(config(), () => {}, fetcher).get("core", ["example"]),
      ),
    ).includes("test-only-token"),
  );
});
test("allowlist and Int32 validation prevent invalid requests", async () => {
  const service = new DevOpsService(
    { ...config(), allowedOrganizations: ["allowed"] },
    reader,
  );
  assert.throws(
    () => service.projects({ organization: "other" }, {}),
    /allowlist/,
  );
  assert.throws(
    () => service.projects({ organization: "../bad" }, {}),
    /valid organization/,
  );
  await assert.rejects(
    service.definition({ organization: "allowed" }, 2147483648),
    /Int32/,
  );
  assert.deepEqual(service.organizations(), {
    source: "configuration",
    verified: false,
    items: [{ name: "allowed" }],
  });
});
test("values default hidden, secrets always hidden, environment scopes remain separate", async () => {
  const service = new DevOpsService(config(), reader);
  assert.ok(!JSON.stringify(await service.variables({}, 7)).includes("hello"));
  const explicit = JSON.stringify(
    await service.variables({}, 7, undefined, true),
  );
  assert.ok(explicit.includes("hello"));
  assert.ok(!explicit.includes("NEVER_OUTPUT"));
  assert.ok(!explicit.includes("HIDE_UNKNOWN"));
  assert.ok(
    !JSON.stringify(await service.definition({}, 7)).includes("NEVER_OUTPUT"),
  );
  const env = await service.variables({}, 7, 9, true);
  assert.equal(env.variables.length, 1);
  assert.equal(env.variables[0]?.value, "dev");
  await assert.rejects(service.variables({}, 7, 88), /Environment not found/);
});
test("official MCP client lists/calls tools and rejects invalid input", async () => {
  const server = createServer(config(), reader);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const list = await client.listTools();
    assert.equal(list.tools.length, 7);
    assert.ok(list.tools.every((t) => t.annotations?.readOnlyHint === true));
    const result = await client.callTool({
      name: "ado_get_release_variables",
      arguments: { definitionId: 7, includeValues: true },
    });
    assert.ok(!JSON.stringify(result).includes("NEVER_OUTPUT"));
    assert.ok(JSON.stringify(result).includes("hello"));
    const invalid = await client.callTool({
      name: "ado_get_release_definition",
      arguments: { definitionId: "7" },
    });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("stdio process initializes without leaking credentials to protocol output", async () => {
  const { StdioClientTransport } =
    await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts"],
    env: { AZDO_PAT: "synthetic-stdio-token", AZDO_ORGANIZATION: "example" },
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 7);
    const result = await client.callTool({
      name: "ado_list_configured_organizations",
      arguments: {},
    });
    assert.ok(JSON.stringify(result).includes("example"));
    assert.ok(!JSON.stringify(result).includes("synthetic-stdio-token"));
  } finally {
    await client.close();
  }
});

test("malformed Azure responses are sanitized and request receives a timeout signal", async () => {
  const fetcher: typeof fetch = async (_url, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ value: "PRIVATE_INVALID_SHAPE" }));
  };
  const adapter = new AzureDevOpsAdapter(
    new RestClient(config(), () => {}, fetcher),
  );
  const result = await toolResult(() => adapter.projects("example", {}));
  assert.equal(result.isError, true);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_INVALID_SHAPE"));
});

test("Accounts discovery uses member UUID and filters results by allowlist", async () => {
  const service = new DevOpsService(
    { ...config(), allowedOrganizations: ["allowed"] },
    reader,
  );
  assert.deepEqual(
    (
      await service.discoverOrganizations(
        "11111111-1111-4111-8111-111111111111",
      )
    ).items,
    [{ id: "1", name: "allowed" }],
  );
  await assert.rejects(service.discoverOrganizations("bad"), /UUID/);
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://app.vssps.visualstudio.com");
    assert.equal(url.pathname, "/_apis/accounts");
    assert.equal(
      url.searchParams.get("memberId"),
      "11111111-1111-4111-8111-111111111111",
    );
    return new Response(
      JSON.stringify({
        value: [
          {
            accountId: "1",
            accountName: "allowed",
            properties: { private: "hidden" },
          },
        ],
      }),
    );
  };
  assert.deepEqual(
    await new AzureDevOpsAdapter(
      new RestClient(config(), () => {}, fetcher),
    ).organizations("11111111-1111-4111-8111-111111111111"),
    [{ id: "1", name: "allowed" }],
  );
});
