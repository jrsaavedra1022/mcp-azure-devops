import { test } from "node:test";
import assert from "node:assert/strict";
import { RestClient } from "../src/client/rest-client.js";
import { loadConfig } from "../src/config.js";
import { AzureReleaseGateway } from "../src/operations/gateway.js";
import { demoRelease } from "../src/operations/demo-gateway.js";
import { ReleaseQueryService } from "../src/services/release-query-service.js";
import { createServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
function fixture(
  options: {
    definitions?: { id: number; name: string }[];
    missing?: boolean;
  } = {},
) {
  const config = loadConfig({
    AZDO_PAT: "synthetic",
    AZDO_ORGANIZATION: "example-org",
    AZDO_PROJECT: "Example Project",
    AZDO_ALLOWED_ORGANIZATIONS: "example-org",
  });
  const calls: URL[] = [];
  const payload = {
    ...structuredClone(demoRelease),
    createdOn: "2026-01-01T00:00:00Z",
    modifiedOn: "2026-01-02T00:00:00Z",
    variables: { secret: { isSecret: true, value: "SECRET_SENTINEL" } },
    description: "SECRET_SENTINEL",
    releaseDefinition: {
      id: 123,
      name: "Example Application",
      secret: "SECRET_SENTINEL",
    },
    artifacts: [
      {
        alias: "application",
        type: "Build",
        secret: "SECRET_SENTINEL",
        definitionReference: {
          version: { id: "101", name: "build.101", secret: "SECRET_SENTINEL" },
          branch: { id: "refs/heads/main" },
          token: { id: "SECRET_SENTINEL" },
        },
      },
    ],
  };
  payload.environments[0]!.variables = {
    secret: { value: "SECRET_SENTINEL", isSecret: true },
  };
  payload.environments[0]!.deploySteps = [
    { attempt: 2, status: "succeeded", tasks: [{ input: "SECRET_SENTINEL" }] },
    { attempt: 1, status: "failed" },
  ];
  const gateway = new AzureReleaseGateway(
    new RestClient(
      config,
      () => {},
      async (input, init) => {
        assert.equal(init?.method, "GET");
        const url = new URL(String(input));
        calls.push(url);
        if (options.missing) return new Response("not found", { status: 404 });
        if (url.pathname.endsWith("/definitions"))
          return Response.json({
            value: options.definitions ?? [
              { id: 123, name: "Example Application" },
            ],
          });
        if (url.pathname.endsWith("/definitions/123"))
          return Response.json({
            id: 123,
            name: "Example Application",
            environments: [{ id: 456, name: "Deploy Certification" }],
          });
        if (url.pathname.endsWith("/deployments")) {
          assert.equal(url.searchParams.get("definitionEnvironmentId"), "456");
          return Response.json({ value: [{ release: { id: 987 } }] });
        }
        if (url.pathname.endsWith("/releases"))
          return Response.json(
            { value: [payload] },
            { headers: { "x-ms-continuationtoken": "next-page" } },
          );
        if (url.pathname.endsWith("/releases/987"))
          return Response.json(payload);
        throw new Error("Unexpected URL");
      },
    ),
  );
  return {
    service: new ReleaseQueryService(config, gateway),
    gateway,
    calls,
    config,
  };
}
test("list releases forwards bounded filters, pagination and safe nested metadata", async () => {
  const { service, calls } = fixture();
  const result = await service.list({
    definitionName: "Example Application",
    status: "active",
    top: 5,
    continuationToken: "previous-page",
    sourceBranch: "refs/heads/main",
  });
  const url = calls.at(-1)!;
  assert.equal(url.searchParams.get("definitionId"), "123");
  assert.equal(url.searchParams.get("$top"), "5");
  assert.equal(url.searchParams.get("continuationToken"), "previous-page");
  assert.equal(url.searchParams.get("statusFilter"), "active");
  assert.equal(url.searchParams.get("sourceBranchFilter"), "refs/heads/main");
  assert.equal(url.searchParams.get("$expand"), "environments,artifacts");
  assert.equal(result.continuationToken, "next-page");
  assert.equal(result.items[0]!.environments![0]!.latestAttempt!.attempt, 2);
  assert.equal(result.items[0]!.createdOn, "2026-01-01T00:00:00Z");
  assert.ok(!JSON.stringify(result).includes("SECRET_SENTINEL"));
  assert.ok(!JSON.stringify(result).includes("variables"));
});
test("get release uses releaseId and maps 404 without disclosing response body", async () => {
  const { service } = fixture();
  assert.equal((await service.get({ releaseId: 987 })).id, 987);
  assert.ok(
    !JSON.stringify(await service.get({ releaseId: 987 })).includes(
      "SECRET_SENTINEL",
    ),
  );
  await assert.rejects(
    fixture({ missing: true }).service.get({ releaseId: 987 }),
    { code: "RELEASE_NOT_FOUND" },
  );
});
for (const reference of [
  { definitionId: 123 },
  { definitionName: "Example Application" },
]) {
  for (const strategy of [
    "latestCreated",
    "latestSuccessfulDeployment",
  ] as const) {
    test(`latest ${strategy} with ${Object.keys(reference)[0]} shares gateway selection`, async () => {
      const { service, gateway, calls } = fixture();
      let selected = 0;
      const original = gateway.select.bind(gateway);
      gateway.select = async (t) => {
        selected++;
        return original(t);
      };
      const result = await service.latest({
        ...reference,
        strategy,
        ...(strategy === "latestSuccessfulDeployment"
          ? { environmentName: "Deploy Certification" }
          : {}),
      });
      assert.equal(result.id, 987);
      assert.equal(selected, 1);
      assert.equal(
        calls.some((u) => u.pathname.endsWith("/deployments")),
        strategy === "latestSuccessfulDeployment",
      );
      assert.ok(!JSON.stringify(result).includes("SECRET_SENTINEL"));
    });
  }
}
test("name resolution errors propagate to public query service", async () => {
  await assert.rejects(
    fixture({ definitions: [] }).service.latest({
      definitionName: "Example Application",
    }),
    { code: "RELEASE_DEFINITION_NOT_FOUND" },
  );
  await assert.rejects(
    fixture({
      definitions: [
        { id: 123, name: "Example Application" },
        { id: 124, name: "Example Application" },
      ],
    }).service.list({ definitionName: "Example Application" }),
    { code: "AMBIGUOUS_RELEASE_DEFINITION" },
  );
});
test("query scope and exclusive input references are validated before any requests", async () => {
  const { service, calls } = fixture();
  await assert.rejects(service.list({ organization: "other-org" }), {
    code: "FORBIDDEN_SCOPE",
  });
  for (const input of [
    {},
    { definitionId: 123, definitionName: "Example Application" },
    { definitionId: 123, strategy: "latestSuccessfulDeployment" },
  ])
    await assert.rejects(service.latest(input), { code: "INVALID_INPUT" });
  await assert.rejects(service.list({ top: 1000 }), { code: "INVALID_INPUT" });
  assert.equal(calls.length, 0);
});
test("three public MCP tools work without catalog and expose read-only metadata", async () => {
  const { config, gateway } = fixture();
  const server = createServer(config, undefined, undefined, gateway);
  const client = new Client({ name: "release-query-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const tools = (await client.listTools()).tools;
    for (const [name, args] of [
      ["ado_list_releases", { top: 5, definitionName: "Example Application" }],
      ["ado_get_release", { releaseId: 987 }],
      ["ado_get_latest_release", { definitionName: "Example Application" }],
    ] as const) {
      assert.equal(
        tools.find((t) => t.name === name)!.annotations!.readOnlyHint,
        true,
      );
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError);
      assert.ok(JSON.stringify(result).includes("987"));
      assert.ok(!JSON.stringify(result).includes("SECRET_SENTINEL"));
    }
  } finally {
    await client.close();
    await server.close();
  }
});
