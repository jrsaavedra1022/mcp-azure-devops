import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadCatalog, digest } from "../src/operations/catalog.js";
import { DemoGateway } from "../src/operations/demo-gateway.js";
import { OperationEngine, type Execution } from "../src/operations/engine.js";
import type { RecordStore } from "../src/operations/store.js";
import { startReviewServer } from "../src/operations/review-server.js";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
async function setup(allow = false, unchanged = false, writes = true) {
  const c = await loadCatalog(resolve("examples/operations.ids.yaml"));
  const op = c.catalog.operations["integration-mode"]!;
  op.deployment.downstreamPolicy = allow ? "allow" : "reject";
  op.deployment.redeployWhenUnchanged = unchanged;
  // Only the one variable for no-change scenarios.
  op.variables = [op.variables[0]!];
  c.hash = digest(c.catalog);
  const gateway = new DemoGateway();
  gateway.release.environments.push({
    ...structuredClone(gateway.release.environments[0]!),
    id: 9002,
    definitionEnvironmentId: 457,
    name: "Acceptance Tests",
    conditions: [
      { name: "Deploy Certification", conditionType: "environmentState" },
    ],
  });
  const engine = new OperationEngine(
    gateway,
    new MemoryStore(),
    async () => c,
    [],
    writes,
    false,
  );
  return { engine, gateway, c };
}
test("default reject remains conservative and unchanged requires explicit opt-in", async () => {
  const c = await loadCatalog(resolve("examples/operations.ids.yaml"));
  assert.equal(
    c.catalog.operations["integration-mode"]!.deployment.downstreamPolicy,
    "reject",
  );
  assert.equal(
    c.catalog.operations["integration-mode"]!.deployment.redeployWhenUnchanged,
    false,
  );
  await assert.rejects(
    (await setup()).engine.plan("integration-mode", "simulated"),
    { code: "DOWNSTREAM_TRIGGER" },
  );
  const { engine, gateway } = await setup(true);
  gateway.release.variables["integration-enabled"]!.value = "true";
  await assert.rejects(engine.plan("integration-mode", "simulated"), {
    code: "NO_CHANGES",
  });
});
test("allow plans, applies and restores while preserving downstream conditions", async () => {
  const { engine, gateway } = await setup(true);
  const downstream = structuredClone(gateway.release.environments[1]!);
  const plan = await engine.plan("integration-mode", "simulated");
  assert.equal(plan.warnings![0]!.code, "DOWNSTREAM_DEPENDENCY");
  assert.deepEqual(plan.warnings![0]!.stages, [
    { id: 9002, name: "Acceptance Tests" },
  ]);
  await engine.applyFromReview(plan.id);
  assert.equal((await engine.refresh(plan.id)).state, "succeeded");
  assert.deepEqual(gateway.release.environments[1], downstream);
  const rollback = await engine.planRollback(plan.id);
  assert.equal(rollback.warnings!.length, 1);
  await engine.applyFromReview(rollback.id);
  assert.equal(gateway.deploys, 2);
  assert.deepEqual(gateway.release.environments[1], downstream);
});
for (const kind of [
  "trigger",
  "condition",
  "active",
  "queued",
  "scheduled",
  "definition",
  "environment",
  "inactive",
] as const) {
  test(`allow still rejects ${kind}`, async () => {
    const { engine, gateway } = await setup(true);
    const env = gateway.release.environments[1]!;
    if (kind === "trigger") env.environmentTriggers = [{}];
    if (kind === "condition")
      env.conditions = [{ name: "Unknown", conditionType: "unknown" }];
    if (["active", "queued", "scheduled"].includes(kind))
      env.status = kind === "active" ? "inProgress" : kind;
    if (kind === "definition") gateway.release.releaseDefinition.id = 999;
    if (kind === "environment") gateway.release.environments[0]!.name = "Other";
    if (kind === "inactive") gateway.release.status = "abandoned";
    await assert.rejects(engine.plan("integration-mode", "simulated"));
    assert.equal(gateway.writes, 0);
    assert.equal(gateway.deploys, 0);
  });
}
test("unchanged values can redeploy without PUT and can prepare restoration", async () => {
  const { engine, gateway } = await setup(true, true);
  gateway.release.variables["integration-enabled"]!.value = "true";
  const plan = await engine.plan("integration-mode", "simulated");
  assert.deepEqual(plan.changes[0]!.before, plan.changes[0]!.after);
  await engine.applyFromReview(plan.id);
  assert.equal(gateway.writes, 0);
  assert.equal(gateway.deploys, 1);
  assert.equal((await engine.refresh(plan.id)).state, "succeeded");
  const rollback = await engine.planRollback(plan.id);
  await engine.applyFromReview(rollback.id);
  assert.equal(gateway.writes, 0);
  assert.equal(gateway.deploys, 2);
});
test("unchanged uncertain deploy is not replayed", async () => {
  const { engine, gateway } = await setup(true, true);
  gateway.release.variables["integration-enabled"]!.value = "true";
  gateway.deploy = async () => {
    gateway.deploys++;
    throw new Error("uncertain");
  };
  const plan = await engine.plan("integration-mode", "simulated");
  assert.equal((await engine.applyFromReview(plan.id)).state, "uncertain");
  await assert.rejects(engine.applyFromReview(plan.id));
  assert.equal(gateway.writes, 0);
  assert.equal(gateway.deploys, 1);
});
test("allow retains fingerprint and catalog conflict checks", async () => {
  for (const cause of ["release", "catalog"]) {
    const { engine, gateway, c } = await setup(true);
    const plan = await engine.plan("integration-mode", "simulated");
    if (cause === "release")
      gateway.release.environments[1]!.conditions[0]!.value = "changed";
    else {
      c.catalog.operations["integration-mode"]!.deployment.downstreamPolicy =
        "reject";
      c.hash = digest(c.catalog);
    }
    assert.equal((await engine.applyFromReview(plan.id)).state, "conflict");
    assert.equal(gateway.writes, 0);
  }
});
test("MCP plan includes warnings; authenticated UI reports disabled writes and backend refuses apply", async () => {
  const { engine, gateway } = await setup(true, true, false);
  const review = await startReviewServer(engine);
  const server = createServer(
    loadConfig({ AZDO_PAT: "synthetic" }),
    undefined,
    { engine, review, close: () => review.close() },
  );
  const client = new Client({ name: "policy-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const result = await client.callTool({
      name: "ado_plan_operation",
      arguments: { operation: "integration-mode", mode: "simulated" },
    });
    assert.ok(!result.isError);
    const serialized = JSON.stringify(result);
    assert.ok(serialized.includes("DOWNSTREAM_DEPENDENCY"));
    assert.ok(!serialized.includes("integration-enabled"));
    const row = (await engine.list())[0]!;
    const url = new URL(review.url(row.id));
    const token = new URLSearchParams(url.hash.slice(1)).get("token")!;
    const response = await fetch(review.origin + "/api/executions/" + row.id, {
      headers: { Authorization: "Bearer " + token },
    });
    const data = (await response.json()) as {
      capabilities: { writesEnabled: boolean };
      warnings: unknown[];
    };
    assert.equal(data.capabilities.writesEnabled, false);
    assert.equal(data.warnings.length, 1);
    await assert.rejects(engine.applyFromReview(row.id), {
      code: "WRITES_DISABLED",
    });
    assert.equal(gateway.writes, 0);
  } finally {
    await client.close();
    await server.close();
    await review.close();
  }
});
