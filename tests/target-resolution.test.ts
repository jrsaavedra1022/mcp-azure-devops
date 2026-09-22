import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  catalogSchema,
  loadCatalog,
  digest,
  type CatalogTarget,
} from "../src/operations/catalog.js";
import { AzureReleaseGateway } from "../src/operations/gateway.js";
import { DemoGateway, demoRelease } from "../src/operations/demo-gateway.js";
import { OperationEngine, type Execution } from "../src/operations/engine.js";
import type { RecordStore } from "../src/operations/store.js";
import { RestClient } from "../src/client/rest-client.js";
import { loadConfig } from "../src/config.js";

const named: CatalogTarget = {
  organization: "example-org",
  project: "Example Project",
  definition: { name: "Example Application" },
  environment: { name: "Deploy Certification" },
  selection: { strategy: "latestCreated" },
};
const strict = {
  organization: named.organization,
  project: named.project,
  definitionId: 123,
  environment: {
    definitionEnvironmentId: 456,
    expectedName: "Deploy Certification",
  },
  selection: named.selection,
};
function harness(
  options: {
    pages?: { id: number; name: string }[][];
    environments?: { id: number; name: string }[];
    detailName?: string;
  } = {},
) {
  const calls: URL[] = [];
  const client = new RestClient(
    loadConfig({ AZDO_PAT: "synthetic", AZDO_MAX_RETRIES: "0" }),
    () => {},
    async (input, init) => {
      assert.ok(
        !init?.method || init.method === "GET",
        "resolution must not write",
      );
      const url = new URL(String(input));
      calls.push(url);
      assert.equal(url.hostname, "vsrm.dev.azure.com");
      let data: unknown;
      let token: string | undefined;
      if (url.pathname.endsWith("/definitions")) {
        assert.equal(url.searchParams.get("isExactNameMatch"), "true");
        assert.equal(url.searchParams.get("searchText"), "Example Application");
        const pages = options.pages ?? [
          [{ id: 123, name: "Example Application" }],
        ];
        const page = Number(url.searchParams.get("continuationToken") ?? "0");
        data = { value: pages[page] ?? [] };
        if (page + 1 < pages.length) token = String(page + 1);
      } else if (url.pathname.endsWith("/definitions/123")) {
        data = {
          id: 123,
          name: options.detailName ?? "Example Application",
          environments: options.environments ?? [
            { id: 456, name: "Deploy Certification" },
          ],
        };
      } else if (url.pathname.endsWith("/releases")) {
        assert.equal(url.searchParams.get("definitionId"), "123");
        assert.equal(url.searchParams.get("statusFilter"), "active");
        data = { value: [{ id: 987 }] };
      } else if (url.pathname.endsWith("/releases/987")) data = demoRelease;
      else throw new Error("Unexpected route: " + url.pathname);
      return new Response(JSON.stringify(data), {
        headers: token ? { "x-ms-continuationtoken": token } : {},
      });
    },
  );
  return { gateway: new AzureReleaseGateway(client), calls };
}
test("catalog accepts IDs, names and independent selectors; rejects mixed or absent references offline", async () => {
  const { catalog } = await loadCatalog(resolve("examples/operations.yaml"));
  const valid = [
    strict,
    named,
    { ...named, environment: strict.environment },
    { ...strict, environment: named.environment },
  ];
  for (const target of valid)
    assert.ok(
      catalogSchema.safeParse({
        ...catalog,
        targets: { certification: target },
      }).success,
    );
  const invalid = [
    { ...named, definitionId: 123 },
    { ...named, definition: undefined },
    {
      ...named,
      environment: { ...strict.environment, name: "Deploy Certification" },
    },
    { ...named, environment: {} },
    { ...named, definition: { name: "Example Application", other: true } },
  ];
  for (const target of invalid)
    assert.equal(
      catalogSchema.safeParse({
        ...catalog,
        targets: { certification: target },
      }).success,
      false,
    );
});
test("legacy IDs require no lookup and remain identical", async () => {
  const { gateway, calls } = harness();
  assert.deepEqual(await gateway.resolveTarget(strict), strict);
  assert.equal(calls.length, 0);
});
test("exact names resolve through all pages to canonical IDs without writes", async () => {
  const { gateway, calls } = harness({
    pages: [
      [{ id: 999, name: "Example Application Extra" }],
      [{ id: 123, name: "Example Application" }],
    ],
  });
  assert.deepEqual(await gateway.resolveTarget(named), strict);
  assert.equal(calls.length, 3);
});
for (const [label, options, code] of [
  [
    "missing definition",
    { pages: [[{ id: 123, name: "example application" }]] },
    "RELEASE_DEFINITION_NOT_FOUND",
  ],
  [
    "ambiguous definition across pages",
    {
      pages: [
        [{ id: 123, name: "Example Application" }],
        [{ id: 124, name: "Example Application" }],
      ],
    },
    "AMBIGUOUS_RELEASE_DEFINITION",
  ],
  [
    "missing environment",
    { environments: [{ id: 456, name: "Other Stage" }] },
    "ENVIRONMENT_NOT_FOUND",
  ],
  [
    "ambiguous environment",
    {
      environments: [
        { id: 456, name: "Deploy Certification" },
        { id: 457, name: "Deploy Certification" },
      ],
    },
    "AMBIGUOUS_ENVIRONMENT",
  ],
  ["renamed during resolution", { detailName: "Renamed" }, "TARGET_CHANGED"],
] as const) {
  test(label, async () => {
    const { gateway } = harness(
      structuredClone(options) as Parameters<typeof harness>[0],
    );
    await assert.rejects(gateway.resolveTarget(named), { code });
  });
}
test("incomplete pagination never proves uniqueness", async () => {
  const { gateway } = harness({
    pages: Array.from({ length: 21 }, () => [
      { id: 123, name: "Example Application" },
    ]),
  });
  await assert.rejects(gateway.resolveTarget(named), { code: "SEARCH_LIMIT" });
});
for (const strategy of ["explicit", "latestCreated"] as const) {
  test(`${strategy} selects the release using resolved IDs`, async () => {
    const { gateway, calls } = harness();
    const target = await gateway.resolveTarget({
      ...named,
      selection:
        strategy === "explicit" ? { strategy, releaseId: 987 } : { strategy },
    });
    assert.equal((await gateway.select(target)).id, 987);
    assert.equal(
      calls.some((u) => u.pathname.endsWith("/releases")),
      strategy === "latestCreated",
    );
  });
}
class MemoryStore implements RecordStore<Execution> {
  rows = new Map<string, Execution>();
  async put(r: Execution) {
    this.rows.set(r.id, structuredClone(r));
  }
  async get(id: string) {
    return structuredClone(this.rows.get(id)!);
  }
  async list() {
    return [...this.rows.values()].map((r) => structuredClone(r));
  }
}
async function engineFixture() {
  const c = await loadCatalog(resolve("examples/operations.yaml"));
  c.catalog.targets.certification = structuredClone(named);
  c.hash = digest(c.catalog);
  const gateway = new DemoGateway(),
    store = new MemoryStore();
  let lookups = 0;
  const original = gateway.resolveTarget.bind(gateway);
  gateway.resolveTarget = async (t) => {
    lookups++;
    return original(t);
  };
  const engine = new OperationEngine(
    gateway,
    store,
    async () => c,
    [],
    true,
    true,
  );
  return { c, gateway, engine, store, lookups: () => lookups };
}
test("execution pins IDs; apply, status and rollback never resolve names again", async () => {
  const { engine, gateway, lookups } = await engineFixture();
  const p = await engine.plan("integration-mode", "simulated");
  assert.deepEqual(p.target, strict);
  assert.equal(gateway.writes, 0);
  gateway.resolveTarget = async () => {
    throw new Error("must not resolve again");
  };
  await engine.applyFromReview(p.id);
  assert.equal((await engine.refresh(p.id)).state, "succeeded");
  const rollback = await engine.planRollback(p.id);
  assert.deepEqual(rollback.target, p.target);
  assert.equal(lookups(), 1);
});
test("catalog changes invalidate a plan without retargeting or writing", async () => {
  const { c, engine, store, gateway, lookups } = await engineFixture();
  const p = await engine.plan("integration-mode", "simulated");
  c.catalog.targets.certification = {
    ...named,
    definition: { name: "Another Application" },
  };
  c.hash = digest(c.catalog);
  assert.equal((await engine.applyFromReview(p.id)).state, "conflict");
  assert.deepEqual((await store.get(p.id)).target, strict);
  assert.equal(gateway.writes, 0);
  assert.equal(lookups(), 1);
});
test("resolved targets still enforce release definition and environment guards", async () => {
  for (const mutate of [
    (g: DemoGateway) => {
      g.release.releaseDefinition.id = 999;
    },
    (g: DemoGateway) => {
      g.release.environments[0]!.name = "Renamed Stage";
    },
  ]) {
    const { engine, gateway } = await engineFixture();
    // Resolve to the expected snapshot even if the release instance differs.
    gateway.resolveTarget = async () => structuredClone(strict);
    mutate(gateway);
    await assert.rejects(engine.plan("integration-mode", "simulated"));
    assert.equal(gateway.writes, 0);
  }
});
