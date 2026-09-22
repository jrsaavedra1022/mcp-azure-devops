import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  catalogSchema,
  loadCatalog,
  digest,
} from "../src/operations/catalog.js";
import { DemoGateway } from "../src/operations/demo-gateway.js";
import { OperationEngine, type Execution } from "../src/operations/engine.js";
import { EncryptedStore, type RecordStore } from "../src/operations/store.js";
import { startReviewServer } from "../src/operations/review-server.js";
import { RestClient } from "../src/client/rest-client.js";
import { loadConfig } from "../src/config.js";
class MemoryStore implements RecordStore<Execution> {
  rows = new Map<string, Execution>();
  async put(r: Execution) {
    this.rows.set(r.id, structuredClone(r));
  }
  async get(id: string) {
    const r = this.rows.get(id);
    if (!r) throw new Error("missing");
    return structuredClone(r);
  }
  async list() {
    return [...this.rows.values()].map((r) => structuredClone(r));
  }
}
async function setup() {
  const c = await loadCatalog(resolve("examples/operations.ids.yaml"));
  const gateway = new DemoGateway(),
    store = new MemoryStore();
  const engine = new OperationEngine(
    gateway,
    store,
    async () => c,
    [],
    true,
    true,
  );
  return { engine, gateway, store, c };
}
test("catalog rejects unknown fields, duplicate variables and missing mappings", async () => {
  const { c } = await setup();
  assert.equal(
    catalogSchema.safeParse({ ...c.catalog, bypass: true }).success,
    false,
  );
  const bad = structuredClone(c.catalog);
  bad.operations["integration-mode"]!.variables.push(
    bad.operations["integration-mode"]!.variables[0]!,
  );
  assert.equal(catalogSchema.safeParse(bad).success, false);
});
test("plan pins release and environment; writes require local apply; rollback restores absence", async () => {
  const { engine, gateway } = await setup();
  const plan = await engine.plan("integration-mode", "simulated");
  assert.equal(gateway.writes, 0);
  assert.equal(plan.releaseId, 987);
  assert.equal(plan.environmentId, 9001);
  assert.equal(plan.changes[1]!.before, null);
  await engine.applyFromReview(plan.id);
  assert.equal(gateway.writes, 1);
  assert.equal(gateway.deploys, 1);
  assert.equal((await engine.refresh(plan.id)).state, "succeeded");
  const rollback = await engine.planRollback(plan.id);
  assert.equal(rollback.releaseId, 987);
  await engine.applyFromReview(rollback.id);
  assert.equal((await engine.refresh(rollback.id)).state, "succeeded");
  assert.equal(
    gateway.release.variables["integration-enabled"]!.value,
    "false",
  );
  assert.equal(
    Object.hasOwn(
      gateway.release.environments[0]!.variables,
      "integration-mode",
    ),
    false,
  );
});
test("concurrent change invalidates plan before any write", async () => {
  const { engine, gateway } = await setup();
  const plan = await engine.plan("integration-mode", "simulated");
  gateway.release.variables["integration-enabled"]!.value = "changed";
  assert.equal((await engine.applyFromReview(plan.id)).state, "conflict");
  assert.equal(gateway.writes, 0);
});
test("duplicate apply never writes/deploys twice", async () => {
  const { engine, gateway } = await setup();
  const p = await engine.plan("integration-mode", "simulated");
  await Promise.allSettled([
    engine.applyFromReview(p.id),
    engine.applyFromReview(p.id),
  ]);
  assert.equal(gateway.writes, 1);
  assert.equal(gateway.deploys, 1);
  await assert.rejects(engine.applyFromReview(p.id));
});
test("secret or unknown-secrecy variable cannot enter plan", async () => {
  for (const value of [true, undefined]) {
    const { engine, gateway } = await setup();
    gateway.release.variables["integration-enabled"]!.isSecret = value;
    await assert.rejects(
      engine.plan("integration-mode", "simulated"),
      /non-secret/,
    );
  }
});
test("downstream trigger, active stage and wrong target are rejected", async () => {
  const { engine, gateway } = await setup();
  gateway.release.environments.push({
    ...structuredClone(gateway.release.environments[0]!),
    id: 9002,
    definitionEnvironmentId: 457,
    name: "Production",
    conditions: [
      { name: "Deploy Certification", conditionType: "environmentState" },
    ],
  });
  await assert.rejects(engine.plan("integration-mode", "simulated"), /depends/);
  gateway.release.environments.pop();
  gateway.release.environments[0]!.status = "inProgress";
  await assert.rejects(engine.plan("integration-mode", "simulated"), /active/);
  gateway.release.environments[0]!.status = "succeeded";
  gateway.release.environments[0]!.name = "Renamed";
  await assert.rejects(
    engine.plan("integration-mode", "simulated"),
    /mismatch/,
  );
});
test("uncertain write is journaled and never followed by deploy", async () => {
  const { engine, gateway } = await setup();
  gateway.update = async () => {
    throw new Error("TOKEN_SHOULD_NOT_LEAK");
  };
  const p = await engine.plan("integration-mode", "simulated");
  const result = await engine.applyFromReview(p.id);
  assert.equal(result.state, "uncertain");
  assert.equal(gateway.deploys, 0);
  assert.ok(!JSON.stringify(result).includes("TOKEN_SHOULD_NOT_LEAK"));
  await assert.rejects(engine.applyFromReview(p.id));
});
test("rollback detects third party changes", async () => {
  const { engine, gateway } = await setup();
  const p = await engine.plan("integration-mode", "simulated");
  await engine.applyFromReview(p.id);
  await engine.refresh(p.id);
  gateway.release.variables["integration-enabled"]!.value = "third-party";
  await assert.rejects(engine.planRollback(p.id), /no longer matches/);
});
test("old successful attempt does not mark new redeploy successful", async () => {
  const { engine, gateway } = await setup();
  gateway.deploy = async () => {};
  const p = await engine.plan("integration-mode", "simulated");
  await engine.applyFromReview(p.id);
  assert.equal((await engine.refresh(p.id)).state, "tracking");
});
test("recovery does not replay interrupted mutation", async () => {
  const { engine, store, gateway } = await setup();
  const p = await engine.plan("integration-mode", "simulated");
  p.state = "requestingDeployment";
  await store.put(p);
  await engine.recover();
  assert.equal((await engine.get(p.id)).state, "interrupted");
  assert.equal(gateway.deploys, 0);
});
test("expired and changed catalog plans fail before mutation", async () => {
  const { engine, store, gateway, c } = await setup();
  const p = await engine.plan("integration-mode", "simulated");
  p.expiresAt = "2000-01-01T00:00:00Z";
  await store.put(p);
  assert.equal((await engine.applyFromReview(p.id)).state, "conflict");
  const q = await engine.plan("integration-mode", "simulated");
  c.hash = "changed";
  assert.equal((await engine.applyFromReview(q.id)).state, "conflict");
  assert.equal(gateway.writes, 0);
});
test("encrypted store persists, authenticates data and enforces one coordinator", async () => {
  const dir = await mkdtemp(join(tmpdir(), "azdo-test-"));
  const first = new EncryptedStore<Execution>(dir);
  try {
    await first.open();
    const { engine } = await setup();
    const p = await engine.plan("integration-mode", "simulated");
    await first.put(p);
    const raw = await readFile(join(dir, p.id + ".enc"));
    assert.ok(!raw.includes(Buffer.from("integration-enabled")));
    assert.equal((await first.get(p.id)).id, p.id);
    const second = new EncryptedStore<Execution>(dir);
    await assert.rejects(second.open(), /coordinator/);
    await first.close();
    await second.open();
    assert.equal((await second.get(p.id)).id, p.id);
    await second.close();
  } finally {
    await first.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("YAML duplicate keys and aliases are rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yaml-test-"));
  try {
    const p = join(dir, "bad.yaml");
    await writeFile(p, 'schemaVersion: "1"\nschemaVersion: "1"\n');
    await assert.rejects(loadCatalog(p));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("loopback API rejects missing auth and cross-origin writes; review page uses external CSP scripts", async () => {
  const { engine } = await setup();
  const p = await engine.plan("integration-mode", "simulated");
  const server = await startReviewServer(engine);
  try {
    assert.equal((await fetch(server.origin + "/api/executions")).status, 403);
    const token = new URLSearchParams(new URL(server.url()).hash.slice(1)).get(
      "token",
    );
    const auth = { Authorization: "Bearer " + token };
    assert.equal(
      (await fetch(server.origin + "/api/executions", { headers: auth }))
        .status,
      200,
    );
    assert.equal(
      (
        await fetch(server.origin + "/api/executions/" + p.id + "/apply", {
          method: "POST",
          headers: {
            ...auth,
            Origin: "https://evil.example",
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    const page = await fetch(server.origin);
    assert.match(
      page.headers.get("content-security-policy")!,
      /frame-ancestors 'none'/,
    );
    assert.ok(!(await page.text()).includes(token!));
  } finally {
    await server.close();
  }
});
test("REST write never retries an uncertain network response", async () => {
  let calls = 0;
  const client = new RestClient(
    loadConfig({ AZDO_PAT: "test" }),
    () => {},
    async () => {
      calls++;
      throw new Error("secret");
    },
  );
  await assert.rejects(
    client.write(
      "PATCH",
      ["org", "project", "_apis", "release", "approvals", "1"],
      { status: "approved" },
    ),
    /Inspect Azure/,
  );
  assert.equal(calls, 1);
});
test("fingerprint is independent of object key ordering", () => {
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
});

test("writes disabled leave reviewed plan untouched", async () => {
  const { gateway, store, c } = await setup();
  const engine = new OperationEngine(
    gateway,
    store,
    async () => c,
    [],
    false,
    false,
  );
  const p = await engine.plan("integration-mode", "simulated");
  await assert.rejects(
    engine.applyFromReview(p.id),
    /WRITES|enable reviewed writes/,
  );
  assert.equal(gateway.writes, 0);
  assert.equal((await engine.get(p.id)).state, "planned");
});
test("approval is bound to pending attempt, requires explicit policy and guards variable changes", async () => {
  const { engine, gateway, c } = await setup();
  c.catalog.operations["integration-mode"]!.approvals = "explicit";
  c.hash = digest(c.catalog);
  const p = await engine.plan("integration-mode", "simulated");
  gateway.deploy = async () => {
    gateway.release.environments[0]!.status = "queued";
    gateway.release.environments[0]!.deploySteps.push({
      attempt: 2,
      status: "queued",
    });
  };
  gateway.approvals = async () => [
    {
      id: 77,
      status: "pending",
      attempt: 2,
      approvalType: "preDeploy",
      approver: "Example approver",
    },
  ];
  let decisions = 0;
  gateway.decide = async () => {
    decisions++;
  };
  await engine.applyFromReview(p.id);
  assert.equal((await engine.refresh(p.id)).state, "awaitingApproval");
  await assert.rejects(
    engine.decideFromReview(p.id, 999, "approved", "Reviewed"),
    /no longer pending/,
  );
  gateway.release.variables["integration-enabled"]!.value = "third-party";
  await assert.rejects(
    engine.decideFromReview(p.id, 77, "approved", "Reviewed"),
    /Variables changed/,
  );
  assert.equal(decisions, 0);
  gateway.release.variables["integration-enabled"]!.value = "true";
  await engine.decideFromReview(p.id, 77, "approved", "Reviewed");
  assert.equal(decisions, 1);
});
test("last successful selection follows deployments, skips abandoned releases and validates branch identity", async () => {
  const { AzureReleaseGateway, matchesBranch } =
    await import("../src/operations/gateway.js");
  const { c, gateway } = await setup();
  let seen = 0;
  const rest = new RestClient(
    loadConfig({ AZDO_PAT: "test" }),
    () => {},
    async (input) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/deployments")) {
        assert.equal(u.searchParams.get("deploymentStatus"), "succeeded");
        assert.equal(u.searchParams.get("definitionEnvironmentId"), "456");
        return new Response(
          JSON.stringify({
            value: [{ release: { id: 986 } }, { release: { id: 987 } }],
          }),
        );
      }
      const release = structuredClone(gateway.release);
      seen++;
      if (u.pathname.endsWith("/986")) release.status = "abandoned";
      return new Response(JSON.stringify(release));
    },
  );
  const r = await new AzureReleaseGateway(rest).select(
    await gateway.resolveTarget(c.catalog.targets.certification!),
  );
  assert.equal(r.id, 987);
  assert.equal(seen, 2);
  assert.equal(matchesBranch(r, "refs/heads/main"), true);
  assert.equal(matchesBranch(r, "Build"), false);
});
test("new MCP tools expose planning and status but no apply bypass", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } =
    await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createServer } = await import("../src/server.js");
  const { engine } = await setup();
  const review = await startReviewServer(engine);
  const server = createServer(
    loadConfig({ AZDO_PAT: "synthetic" }),
    undefined,
    { engine, review, close: () => review.close() },
  );
  const client = new Client({ name: "operations-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.equal(names.length, 13);
    assert.ok(!names.some((n) => n.includes("apply")));
    const r = await client.callTool({
      name: "ado_plan_operation",
      arguments: { operation: "integration-mode", mode: "simulated" },
    });
    assert.ok(JSON.stringify(r).includes("reviewUrl"));
    assert.ok(!JSON.stringify(r).includes("integration-enabled"));
  } finally {
    await client.close();
    await server.close();
    await review.close();
  }
});
