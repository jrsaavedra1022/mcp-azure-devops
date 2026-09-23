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
    Date.now,
    async () => {},
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
test("secret variables cannot enter plan", async () => {
  for (const value of [true]) {
    const { engine, gateway } = await setup();
    gateway.release.variables["integration-enabled"]!.isSecret = value;
    await assert.rejects(
      engine.plan("integration-mode", "simulated"),
      /Secret variables/,
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
  await engine.decideFromReview(p.id, 77, "approved", "Reviewed");
  assert.equal(decisions, 1);
  gateway.release.variables["integration-enabled"]!.value = "third-party";
  await assert.rejects(
    engine.decideFromReview(p.id, 77, "approved", "Reviewed"),
    /Variables changed/,
  );
  assert.equal(decisions, 1);
  assert.equal((await engine.get(p.id)).state, "uncertain");
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
    assert.equal(names.length, 16);
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

for (const flag of [false, undefined]) {
  for (const scope of ["release", "environment"] as const) {
    test(`visible string with isSecret=${String(flag)} at ${scope} supports plan, apply and rollback`, async () => {
      const { c, engine, gateway } = await setup();
      const op = c.catalog.operations["integration-mode"]!;
      op.variables = [{ ...op.variables[0]!, scope }];
      c.hash = digest(c.catalog);
      const vars =
        scope === "release"
          ? gateway.release.variables
          : gateway.release.environments[0]!.variables;
      vars["integration-enabled"] = {
        value: "false",
        ...(flag === undefined ? {} : { isSecret: flag }),
      };
      const original = structuredClone(vars["integration-enabled"]);
      gateway.release.variables["untouched-secret"] = {
        isSecret: true,
        value: "SECRET_SENTINEL",
      };
      gateway.release.variables["untouched-normal"] = { value: "keep" };
      const plan = await engine.plan("integration-mode", "simulated");
      assert.deepEqual(plan.changes[0]!.before, original);
      assert.ok(!JSON.stringify(plan).includes("SECRET_SENTINEL"));
      await engine.applyFromReview(plan.id);
      assert.equal((await engine.refresh(plan.id)).state, "succeeded");
      const rollback = await engine.planRollback(plan.id);
      assert.deepEqual(rollback.changes[0]!.after, original);
      await engine.applyFromReview(rollback.id);
      assert.equal((await engine.refresh(rollback.id)).state, "succeeded");
      const restored =
        scope === "release"
          ? gateway.release.variables
          : gateway.release.environments[0]!.variables;
      assert.deepEqual(restored["integration-enabled"], original);
      assert.deepEqual(gateway.release.variables["untouched-secret"], {
        isSecret: true,
        value: "SECRET_SENTINEL",
      });
      assert.deepEqual(gateway.release.variables["untouched-normal"], {
        value: "keep",
      });
      assert.equal(gateway.deploys, 2);
    });
  }
}
for (const [label, variable] of [
  ["secret string", { isSecret: true, value: "SECRET_SENTINEL" }],
  ["secret placeholder", { isSecret: true, value: "***" }],
  ["null value", { value: null }],
  ["missing value", {}],
  ["false flag null value", { isSecret: false, value: null }],
  ["false flag missing value", { isSecret: false }],
] as const) {
  test(`${label} is refused by both planning and restoration without exposing values`, async () => {
    const { engine, gateway, store } = await setup();
    gateway.release.variables["integration-enabled"] = { ...variable };
    const { toolResult } = await import("../src/tools/register.js");
    const result = await toolResult(() =>
      engine.plan("integration-mode", "simulated"),
    );
    assert.equal(result.isError, true);
    assert.ok(JSON.stringify(result).includes("UNSUPPORTED_SECRET"));
    assert.ok(!JSON.stringify(result).includes("SECRET_SENTINEL"));
    assert.ok(!JSON.stringify(result).includes("***"));
    assert.equal((await store.list()).length, 0);
    gateway.release.variables["integration-enabled"] = { value: "false" };
    const plan = await engine.plan("integration-mode", "simulated");
    await engine.applyFromReview(plan.id);
    await engine.refresh(plan.id);
    gateway.release.variables["integration-enabled"] = { ...variable };
    await assert.rejects(engine.planRollback(plan.id), {
      code: "UNSUPPORTED_SECRET",
    });
    assert.ok(!JSON.stringify(await store.list()).includes("SECRET_SENTINEL"));
  });
}
test("Azure omitting false flags after saving does not cause false conflicts in apply, tracking or rollback", async () => {
  const { engine, gateway } = await setup();
  const update = gateway.update.bind(gateway);
  gateway.update = async (target, release) => {
    await update(target, release);
    for (const vars of [
      gateway.release.variables,
      ...gateway.release.environments.map((e) => e.variables),
    ]) {
      for (const v of Object.values(vars))
        if (v.isSecret === false) delete v.isSecret;
    }
  };
  const plan = await engine.plan("integration-mode", "simulated");
  await engine.applyFromReview(plan.id);
  assert.equal((await engine.refresh(plan.id)).state, "succeeded");
  const rollback = await engine.planRollback(plan.id);
  await engine.applyFromReview(rollback.id);
  assert.equal((await engine.refresh(rollback.id)).state, "succeeded");
  assert.equal(
    gateway.release.variables["integration-enabled"]!.value,
    "false",
  );
  assert.equal(gateway.deploys, 2);
});
test("normalization never hides true secrecy or actual value changes after review", async () => {
  for (const change of [
    { isSecret: true, value: "false" },
    { value: null },
    { value: "changed" },
  ]) {
    const { engine, gateway } = await setup();
    gateway.release.variables["integration-enabled"] = { value: "false" };
    const plan = await engine.plan("integration-mode", "simulated");
    gateway.release.variables["integration-enabled"] = change;
    assert.equal((await engine.applyFromReview(plan.id)).state, "conflict");
    assert.equal(gateway.writes, 0);
    assert.equal(gateway.deploys, 0);
  }
});
test("review API and event logs include visible flagless diff but never unrelated secret values", async () => {
  const { engine, gateway } = await setup();
  gateway.release.variables["integration-enabled"] = { value: "false" };
  gateway.release.variables["untouched-secret"] = {
    isSecret: true,
    value: "SECRET_SENTINEL",
  };
  const plan = await engine.plan("integration-mode", "simulated");
  const review = await startReviewServer(engine);
  try {
    const token = new URLSearchParams(new URL(review.url()).hash.slice(1)).get(
      "token",
    )!;
    const response = await fetch(review.origin + "/api/executions/" + plan.id, {
      headers: { Authorization: "Bearer " + token },
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(text.includes("integration-enabled"));
    assert.ok(!text.includes("SECRET_SENTINEL"));
    await engine.applyFromReview(plan.id);
    const finished = await engine.refresh(plan.id);
    assert.ok(!JSON.stringify(finished.events).includes("SECRET_SENTINEL"));
    assert.ok(!JSON.stringify(finished).includes("SECRET_SENTINEL"));
  } finally {
    await review.close();
  }
});

for (const scope of ["release", "environment"] as const) {
  for (const normalization of ["omit", "add"] as const) {
    test(`post-PUT ${normalization} allowOverride at ${scope} verifies value and redeploys`, async () => {
      const { c, engine, gateway } = await setup();
      const op = c.catalog.operations["integration-mode"]!;
      op.variables = [{ ...op.variables[0]!, scope }];
      c.hash = digest(c.catalog);
      const vars =
        scope === "release"
          ? gateway.release.variables
          : gateway.release.environments[0]!.variables;
      vars["integration-enabled"] = {
        value: "false",
        ...(normalization === "omit"
          ? { allowOverride: false, serverMetadata: "original" }
          : {}),
      };
      const update = gateway.update.bind(gateway);
      gateway.update = async (target, release) => {
        const requested =
          scope === "release"
            ? release.variables
            : release.environments[0]!.variables;
        if (normalization === "omit")
          assert.equal(requested["integration-enabled"]!.allowOverride, false);
        await update(target, release);
        const saved =
          scope === "release"
            ? gateway.release.variables
            : gateway.release.environments[0]!.variables;
        if (normalization === "omit") {
          delete saved["integration-enabled"]!.allowOverride;
          delete saved["integration-enabled"]!.serverMetadata;
        } else {
          saved["integration-enabled"]!.allowOverride = false;
          saved["integration-enabled"]!.serverMetadata = "normalized";
        }
      };
      const plan = await engine.plan("integration-mode", "simulated");
      const result = await engine.applyFromReview(plan.id);
      assert.equal(result.state, "tracking");
      assert.equal(gateway.deploys, 1);
      assert.equal(result.error, undefined);
      assert.deepEqual(
        result.events.slice(-4).map((e) => e.message),
        [
          "Variables saved and verified.",
          "Post-update validation passed.",
          "Requesting environment redeploy.",
          "Deployment request accepted; waiting for this deployment attempt.",
        ],
      );
      assert.equal((await engine.refresh(plan.id)).state, "succeeded");
      const rollback = await engine.planRollback(plan.id);
      assert.equal(
        (await engine.applyFromReview(rollback.id)).state,
        "tracking",
      );
      assert.equal((await engine.refresh(rollback.id)).state, "succeeded");
      assert.equal(gateway.deploys, 2);
    });
  }
}
for (const [label, actual] of [
  ["different value", { value: "SECRET_SENTINEL" }],
  ["secret value", { value: "true", isSecret: true }],
  ["hidden value", { value: null }],
  ["undefined value", {}],
  ["missing variable", null],
] as const) {
  test(`post-PUT ${label} blocks redeploy without leaking values`, async () => {
    const { engine, gateway } = await setup();
    const update = gateway.update.bind(gateway);
    gateway.update = async (t, r) => {
      await update(t, r);
      if (actual === null)
        delete gateway.release.variables["integration-enabled"];
      else gateway.release.variables["integration-enabled"] = { ...actual };
    };
    const p = await engine.plan("integration-mode", "simulated");
    const result = await engine.applyFromReview(p.id);
    assert.equal(result.state, "uncertain");
    assert.equal(
      result.error!.code,
      label === "secret value" ? "UNSUPPORTED_SECRET" : "VERIFY_FAILED",
    );
    assert.equal(gateway.deploys, 0);
    assert.ok(
      result.events.some(
        (e) =>
          e.message ===
          "Variable update could not be verified; redeploy was not requested.",
      ),
    );
    assert.ok(!JSON.stringify(result).includes("SECRET_SENTINEL"));
    await assert.rejects(engine.applyFromReview(p.id));
    assert.equal(gateway.writes, 1);
  });
}
test("creation accepts normalized metadata and restoration requires actual absence", async () => {
  const { engine, gateway } = await setup();
  const update = gateway.update.bind(gateway);
  let preventDeletion = false;
  gateway.update = async (t, r) => {
    await update(t, r);
    const vars = gateway.release.environments[0]!.variables;
    if (vars["integration-mode"])
      vars["integration-mode"]!.allowOverride = false;
    else if (preventDeletion)
      vars["integration-mode"] = { value: "simulation" };
  };
  const p = await engine.plan("integration-mode", "simulated");
  await engine.applyFromReview(p.id);
  await engine.refresh(p.id);
  assert.equal(gateway.deploys, 1);
  const restore = await engine.planRollback(p.id);
  preventDeletion = true;
  const result = await engine.applyFromReview(restore.id);
  assert.equal(result.error!.code, "VERIFY_FAILED");
  assert.equal(gateway.deploys, 1);
});
test("pre-write metadata and post-write unrelated value changes still conflict", async () => {
  for (const phase of ["before", "after"]) {
    const { engine, gateway } = await setup();
    gateway.release.variables.unrelated = {
      value: "keep",
      allowOverride: false,
    };
    const p = await engine.plan("integration-mode", "simulated");
    if (phase === "before")
      gateway.release.variables["integration-enabled"]!.allowOverride = true;
    else {
      const update = gateway.update.bind(gateway);
      gateway.update = async (t, r) => {
        await update(t, r);
        gateway.release.variables.unrelated!.value = "third-party";
      };
    }
    const result = await engine.applyFromReview(p.id);
    assert.equal(result.state, phase === "before" ? "conflict" : "uncertain");
    assert.equal(gateway.deploys, 0);
  }
});
test("tracking ignores metadata but rejects actual value/secrecy changes", async () => {
  for (const kind of ["metadata", "value", "secret"]) {
    const { engine, gateway } = await setup();
    const p = await engine.plan("integration-mode", "simulated");
    await engine.applyFromReview(p.id);
    const v = gateway.release.variables["integration-enabled"]!;
    if (kind === "metadata") v.allowOverride = true;
    if (kind === "value") v.value = "false";
    if (kind === "secret") v.isSecret = true;
    assert.equal(
      (await engine.refresh(p.id)).state,
      kind === "metadata" ? "succeeded" : "uncertain",
    );
  }
});
test("semantic matching is strict about value types, secrets and existence", async () => {
  const { matchesExpectedVariable: matches } =
    await import("../src/operations/variable-state.js");
  assert.equal(matches(undefined, null), true);
  assert.equal(matches(null, null), true);
  assert.equal(matches({ value: "false" }, null), false);
  assert.equal(
    matches(
      { value: "true", allowOverride: true },
      { value: "true", allowOverride: false },
    ),
    true,
  );
  assert.equal(
    matches({ value: "true", isSecret: true }, { value: "true" }),
    false,
  );
  assert.equal(matches({ value: null }, { value: "true" }), false);
  assert.equal(matches({}, { value: "true" }), false);
  assert.equal(matches({ value: "TRUE" }, { value: "true" }), false);
  // Runtime defense even when a malformed adapter bypasses the typed Azure schema.
  assert.equal(
    matches({ value: true } as unknown as Parameters<typeof matches>[0], {
      value: "true",
    }),
    false,
  );
});
