import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { RestClient } from "../src/client/rest-client.js";
import { loadConfig } from "../src/config.js";
import {
  AzureReleaseGateway,
  releaseSchema,
  type Release,
} from "../src/operations/gateway.js";
import { loadCatalog, digest } from "../src/operations/catalog.js";
import { OperationEngine, type Execution } from "../src/operations/engine.js";
import type { RecordStore } from "../src/operations/store.js";
import { attemptOutcome } from "../src/operations/attempt-state.js";
import { classifyEnvironmentCondition } from "../src/operations/environment-policy.js";
class MemoryStore implements RecordStore<Execution> {
  rows = new Map<string, Execution>();
  async put(row: Execution) {
    this.rows.set(row.id, structuredClone(row));
  }
  async get(id: string) {
    const row = this.rows.get(id);
    if (!row) throw Error("missing");
    return structuredClone(row);
  }
  async list() {
    return structuredClone([...this.rows.values()]);
  }
}
// HTTP contract fixture. No DemoGateway: requests traverse the real gateway and REST client.
function fixture(): Release {
  return releaseSchema.parse({
    id: 987,
    name: "Release-42",
    status: "active",
    revision: 1,
    releaseDefinition: { id: 123 },
    variables: {
      "integration-enabled": { value: "false" },
      credential: { value: null, isSecret: true },
    },
    artifacts: [
      {
        alias: "application",
        type: "Build",
        definitionReference: {
          version: { id: "101", name: "build.101" },
          branch: { id: "refs/heads/main" },
        },
      },
    ],
    environments: [
      {
        id: 9001,
        definitionEnvironmentId: 456,
        name: "Deploy Certification",
        status: "succeeded",
        variables: {},
        conditions: [{ name: "ReleaseStarted", conditionType: "event" }],
        environmentTriggers: [],
        deploySteps: [{ attempt: 1, status: "succeeded", id: 31 }],
      },
    ],
  });
}
async function setup(
  options: {
    unchanged?: boolean;
    uncertain?: "PUT" | "PATCH";
    patchStatus?: number;
    stale?: number;
    approvalsDenied?: boolean;
    writes?: boolean;
    afterPut?: (r: Release) => void;
  } = {},
) {
  const c = await loadCatalog(resolve("examples/operations.ids.yaml"));
  c.catalog.targets.certification!.selection = {
    strategy: "explicit",
    releaseId: 987,
    sourceBranch: "refs/heads/main",
  };
  c.catalog.operations["integration-mode"]!.deployment.redeployWhenUnchanged =
    true;
  c.hash = digest(c.catalog);
  let release = fixture(),
    stale: Release | undefined;
  if (options.unchanged) {
    release.variables["integration-enabled"]!.value = "true";
    release.environments[0]!.variables["integration-mode"] = {
      value: "simulation",
    };
  }
  let remaining = options.stale ?? 1,
    now = Date.now();
  const calls: { method: string; path: string; body?: unknown }[] = [],
    logs: unknown[] = [],
    sleeps: number[] = [];
  const client = new RestClient(
    loadConfig({ AZDO_PAT: "TOKEN_SENTINEL", AZDO_MAX_RETRIES: "3" }),
    (...args) => logs.push(args),
    async (input, init) => {
      const url = new URL(String(input)),
        method = init?.method ?? "GET";
      assert.equal(url.origin, "https://vsrm.dev.azure.com");
      assert.equal(url.searchParams.get("api-version"), "7.1");
      const call = {
        method,
        path: url.pathname,
        ...(init?.body
          ? { body: JSON.parse(String(init.body)) as unknown }
          : {}),
      };
      calls.push(call);
      if (method === "PUT") {
        assert.equal(
          url.pathname,
          "/example-org/Example%20Project/_apis/release/releases/987",
        );
        stale = structuredClone(release);
        remaining = options.stale ?? 1;
        release = releaseSchema.parse(call.body);
        if (options.uncertain === "PUT")
          throw Error("TOKEN_SENTINEL socket reset after send");
        release.revision = Number(release.revision) + 1;
        release.modifiedOn = "2026-01-02T00:00:00Z";
        release.modifiedBy = { displayName: "Example operator" };
        release._links = { web: { href: "https://example.invalid/release" } };
        for (const v of Object.values(release.variables))
          if (v.isSecret !== true) {
            v.isSecret = false;
            v.allowOverride = true;
            v.serverGenerated = "normalized";
          }
        release.environments[0]!.serverGenerated = { revision: 77 };
        options.afterPut?.(release);
        return new Response(null, { status: 204 });
      }
      if (method === "PATCH") {
        assert.equal(
          url.pathname,
          "/example-org/Example%20Project/_apis/release/releases/987/environments/9001",
        );
        assert.deepEqual(Object.keys(call.body as object).sort(), [
          "comment",
          "status",
        ]);
        assert.equal((call.body as { status: string }).status, "inProgress");
        assert.match(
          (call.body as { comment: string }).comment,
          /^MCP operation [a-f0-9-]{36}$/,
        );
        if (options.uncertain === "PATCH")
          throw Error("TOKEN_SENTINEL timeout after send");
        return new Response(null, { status: options.patchStatus ?? 202 });
      }
      if (url.pathname.endsWith("/approvals"))
        return new Response(
          JSON.stringify(
            options.approvalsDenied
              ? { message: "TOKEN_SENTINEL" }
              : { value: [] },
          ),
          { status: options.approvalsDenied ? 403 : 200 },
        );
      assert.ok(url.pathname.endsWith("/releases/987"));
      const result = stale && remaining-- > 0 ? stale : release;
      return new Response(JSON.stringify(result));
    },
    async () => {
      throw Error("Unexpected automatic HTTP retry");
    },
  );
  const store = new MemoryStore();
  const engine = new OperationEngine(
    new AzureReleaseGateway(client),
    store,
    async () => c,
    [],
    options.writes ?? true,
    false,
    () => now,
    async (ms) => {
      sleeps.push(ms);
    },
  );
  return {
    engine,
    store,
    c,
    calls,
    logs,
    sleeps,
    release: () => release,
    advance: () => {
      now += 2 * 86400000;
    },
    count: (method: string) => calls.filter((c) => c.method === method).length,
    observe(status?: string, attempt = 2) {
      release.environments[0]!.deploySteps.push({
        attempt,
        ...(status ? { status } : {}),
        id: 30 + attempt,
      });
    },
  };
}
test("HTTP full flow: stale read, metadata normalization, exact instance PATCH, delayed attempt and external approvals 403", async () => {
  const h = await setup({ approvalsDenied: true });
  const p = await h.engine.plan("integration-mode", "simulated");
  const applied = await h.engine.applyFromReview(p.id);
  assert.equal(applied.state, "tracking");
  assert.deepEqual(h.sleeps, [750]);
  assert.equal(h.count("PUT"), 1);
  assert.equal(h.count("PATCH"), 1);
  assert.equal((await h.engine.refresh(p.id)).state, "tracking");
  assert.equal((await h.engine.refresh(p.id)).state, "tracking");
  h.observe("inProgress"); // environment deliberately still says succeeded from attempt 1
  assert.equal((await h.engine.refresh(p.id)).state, "tracking");
  h.release().environments[0]!.deploySteps[1]!.status = "succeeded";
  const done = await h.engine.refresh(p.id);
  assert.equal(done.state, "succeeded");
  assert.equal(done.observedAttempt, 2);
  assert.equal(done.observabilityError?.status, 403);
  assert.ok(
    done.events.some((e) => e.message === "Deployment attempt detected: 2."),
  );
  assert.ok(!JSON.stringify({ done, logs: h.logs }).includes("TOKEN_SENTINEL"));
  assert.equal(h.count("PUT"), 1);
  assert.equal(h.count("PATCH"), 1);
});
for (const patchStatus of [200, 202, 204])
  test(`HTTP unchanged path skips PUT, accepts PATCH ${patchStatus} and tracks new attempt`, async () => {
    const h = await setup({ unchanged: true, patchStatus });
    const p = await h.engine.plan("integration-mode", "simulated");
    assert.equal((await h.engine.applyFromReview(p.id)).state, "tracking");
    assert.equal(h.count("PUT"), 0);
    assert.equal(h.count("PATCH"), 1);
    assert.equal((await h.engine.refresh(p.id)).state, "tracking");
    h.observe("succeeded");
    assert.equal((await h.engine.refresh(p.id)).state, "succeeded");
  });
for (const uncertain of ["PUT", "PATCH"] as const)
  test(`HTTP ${uncertain} network uncertainty never retries writes and preserves recovery history`, async () => {
    const h = await setup({ uncertain, stale: 0 });
    const p = await h.engine.plan("integration-mode", "simulated");
    const r = await h.engine.applyFromReview(p.id);
    assert.equal(r.state, "uncertain");
    assert.equal(r.error?.code, "WRITE_UNCERTAIN");
    assert.equal(
      r.lastMutation,
      uncertain === "PUT" ? "variables" : "deployment",
    );
    assert.equal(h.count("PUT"), 1);
    assert.equal(h.count("PATCH"), uncertain === "PATCH" ? 1 : 0);
    await h.engine.recover();
    await h.engine.refresh(p.id);
    await assert.rejects(h.engine.planRollback(p.id));
    const blocked = await h.engine.plan("integration-mode", "live");
    assert.equal(
      (await h.engine.applyFromReview(blocked.id)).error?.code,
      "BUSY",
    );
    const writes = h.count("PUT") + h.count("PATCH");
    await h.engine.acknowledgeRecovery(p.id);
    const reconciled = await h.engine.get(p.id);
    assert.equal(reconciled.state, "failed");
    assert.ok(reconciled.events.length > r.events.length);
    assert.equal(h.count("PUT") + h.count("PATCH"), writes);
  });
test("HTTP read-after-write exhausted: at most five GETs, one PUT, no PATCH", async () => {
  const h = await setup({ stale: 99 });
  const p = await h.engine.plan("integration-mode", "simulated");
  const r = await h.engine.applyFromReview(p.id);
  assert.equal(r.state, "uncertain");
  assert.equal(r.error?.code, "VERIFY_FAILED");
  assert.equal(h.count("GET"), 7);
  assert.equal(h.sleeps.length, 4);
  assert.equal(h.count("PUT"), 1);
  assert.equal(h.count("PATCH"), 0);
});
for (const kind of [
  "artifact",
  "branch",
  "target",
  "busy",
  "outsideDiff",
] as const)
  test(`HTTP post-PUT real ${kind} change blocks PATCH`, async () => {
    const h = await setup({
      stale: 0,
      afterPut(r) {
        if (kind === "artifact" || kind === "branch") {
          r.artifacts = [
            {
              alias: "application",
              type: "Build",
              definitionReference: {
                version: {
                  id: kind === "artifact" ? "102" : "101",
                  name: "build.101",
                },
                branch: {
                  id:
                    kind === "branch" ? "refs/heads/other" : "refs/heads/main",
                },
              },
            },
          ];
        }
        if (kind === "target") r.environments[0]!.id++;
        if (kind === "busy") r.environments[0]!.status = "inProgress";
        if (kind === "outsideDiff")
          r.variables.unreviewed = { value: "changed" };
      },
    });
    const p = await h.engine.plan("integration-mode", "simulated");
    const r = await h.engine.applyFromReview(p.id);
    assert.equal(r.state, "uncertain");
    assert.equal(h.count("PATCH"), 0);
    assert.equal(
      r.error?.code,
      kind === "busy"
        ? "DEPLOYMENT_BUSY"
        : kind === "target"
          ? "POST_UPDATE_TARGET_CHANGED"
          : kind === "outsideDiff"
            ? "POST_UPDATE_VARIABLE_CHANGED"
            : "POST_UPDATE_ARTIFACT_CHANGED",
    );
  });
test("HTTP pre-write third-party metadata still conflicts before writes", async () => {
  const h = await setup();
  const p = await h.engine.plan("integration-mode", "simulated");
  h.release().revision = 9;
  assert.equal((await h.engine.applyFromReview(p.id)).error?.code, "CONFLICT");
  assert.equal(h.count("PUT"), 0);
  assert.equal(h.count("PATCH"), 0);
});
test("HTTP rollback uses same verification, restores flagless value and confirms created variable absence", async () => {
  const h = await setup();
  const p = await h.engine.plan("integration-mode", "simulated");
  await h.engine.applyFromReview(p.id);
  h.observe("succeeded");
  await h.engine.refresh(p.id);
  const rollback = await h.engine.planRollback(p.id);
  const r = await h.engine.applyFromReview(rollback.id);
  assert.equal(r.state, "tracking");
  assert.equal(h.release().variables["integration-enabled"]!.value, "false");
  assert.equal(
    Object.hasOwn(h.release().environments[0]!.variables, "integration-mode"),
    false,
  );
  h.observe("succeeded", 3);
  assert.equal((await h.engine.refresh(rollback.id)).state, "succeeded");
  assert.equal(h.count("PUT"), 2);
  assert.equal(h.count("PATCH"), 2);
});
for (const observed of [false, true])
  test(`HTTP tracking timeout distinguishes observed=${observed}; no replay`, async () => {
    const h = await setup();
    const p = await h.engine.plan("integration-mode", "simulated");
    await h.engine.applyFromReview(p.id);
    if (observed) h.observe("unknown-future-status");
    await h.engine.refresh(p.id);
    h.advance();
    const r = await h.engine.refresh(p.id);
    assert.equal(r.state, "trackingTimedOut");
    assert.equal(
      r.error?.code,
      observed ? "TRACKING_TIMEOUT" : "DEPLOYMENT_NOT_OBSERVED",
    );
    assert.equal(h.count("PATCH"), 1);
  });
for (const status of [
  "queued",
  "inProgress",
  "succeeded",
  "partiallySucceeded",
  "failed",
  "canceled",
  "rejected",
  undefined,
  "future",
])
  test(`specific attempt status ${status} never inherits environment status`, () => {
    const expected =
      status === "succeeded"
        ? "succeeded"
        : ["partiallySucceeded", "failed", "canceled", "rejected"].includes(
              status ?? "",
            )
          ? "failed"
          : "tracking";
    assert.equal(attemptOutcome({ attempt: 2, status }), expected);
  });
test("known condition classification; arbitrary event remains unknown", () => {
  assert.equal(
    classifyEnvironmentCondition({
      name: "ReleaseStarted",
      conditionType: "event",
    }),
    "releaseStart",
  );
  assert.equal(
    classifyEnvironmentCondition({
      name: "application",
      conditionType: "artifact",
    }),
    "artifactFilter",
  );
  assert.equal(
    classifyEnvironmentCondition({
      name: "Deploy",
      conditionType: "environmentState",
    }),
    "dependency",
  );
  assert.equal(
    classifyEnvironmentCondition({
      name: "Unexpected",
      conditionType: "event",
    }),
    "unknown",
  );
});
for (const relationship of [
  "selected",
  "downstream",
  "unrelated",
  "unknown",
  "global",
] as const)
  test(`stage concurrency policy: ${relationship}`, async () => {
    const h = await setup();
    const op = h.c.catalog.operations["integration-mode"]!;
    op.deployment.downstreamPolicy = "allow";
    if (relationship !== "global")
      op.variables = op.variables.filter((v) => v.scope === "environment");
    if (relationship === "selected")
      h.release().environments[0]!.status = "queued";
    else
      h.release().environments.push({
        ...structuredClone(h.release().environments[0]!),
        id: 9002,
        definitionEnvironmentId: 457,
        name: "Independent Analysis",
        status: "inProgress",
        conditions:
          relationship === "downstream"
            ? [
                {
                  conditionType: "environmentState",
                  name: "Deploy Certification",
                },
              ]
            : relationship === "unknown"
              ? [{ conditionType: "event", name: "Unrecognized" }]
              : [{ conditionType: "event", name: "ReleaseStarted" }],
      });
    h.c.hash = digest(h.c.catalog);
    if (relationship === "unrelated") {
      const p = await h.engine.plan("integration-mode", "simulated");
      assert.equal((await h.engine.applyFromReview(p.id)).state, "tracking");
    } else
      await assert.rejects(h.engine.plan("integration-mode", "simulated"), {
        code:
          relationship === "unknown"
            ? "UNVERIFIED_TRIGGERS"
            : "DEPLOYMENT_BUSY",
      });
  });
test("HTTP writes disabled leaves reviewed plan intact without PUT or PATCH", async () => {
  const h = await setup({ writes: false });
  const p = await h.engine.plan("integration-mode", "simulated");
  await assert.rejects(h.engine.applyFromReview(p.id), {
    code: "WRITES_DISABLED",
  });
  assert.equal((await h.engine.get(p.id)).state, "planned");
  assert.equal(h.count("PUT") + h.count("PATCH"), 0);
});
for (const triggerType of [
  "deploymentGroupRedeploy",
  "rollbackRedeploy",
  "TOKEN_SENTINEL",
])
  test(`unsupported environment trigger fails closed with safe diagnostic (${triggerType === "TOKEN_SENTINEL" ? "unknown" : triggerType})`, async () => {
    const h = await setup();
    h.release().environments[0]!.environmentTriggers = [
      { triggerType, triggerContent: "TOKEN_SENTINEL" },
    ];
    await assert.rejects(
      h.engine.plan("integration-mode", "simulated"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Deploy Certification.*9001/);
        assert.ok(!error.message.includes("TOKEN_SENTINEL"));
        return true;
      },
    );
  });
test("HTTP a newer attempt or changed observed deployment identity requires reconciliation", async () => {
  for (const kind of ["newer", "identity", "artifact"]) {
    const h = await setup();
    const p = await h.engine.plan("integration-mode", "simulated");
    await h.engine.applyFromReview(p.id);
    h.observe("inProgress");
    await h.engine.refresh(p.id);
    if (kind === "newer") h.observe("succeeded", 3);
    if (kind === "identity")
      h.release().environments[0]!.deploySteps[1]!.id = 999;
    if (kind === "artifact") h.release().artifacts = [];
    assert.equal((await h.engine.refresh(p.id)).state, "uncertain");
    assert.equal(h.count("PATCH"), 1);
  }
});
test("HTTP rollback tolerates a stale pre-deletion read", async () => {
  // Deletion must be absent, not just hidden or metadata-normalized.
  const h = await setup({ stale: 1 });
  const p = await h.engine.plan("integration-mode", "simulated");
  await h.engine.applyFromReview(p.id);
  h.observe("succeeded");
  await h.engine.refresh(p.id);
  const rollback = await h.engine.planRollback(p.id);
  assert.equal(
    rollback.changes.find((d) => d.name === "integration-mode")!.after,
    null,
  );
  assert.equal((await h.engine.applyFromReview(rollback.id)).state, "tracking");
  assert.equal(h.sleeps.length, 2);
  assert.equal(h.count("PUT"), 2);
  assert.equal(h.count("PATCH"), 2);
});
test("attempt operationStatus cancellation/rejection prevents success", () => {
  for (const operationStatus of [
    "rejected",
    "canceled",
    "phaseCanceled",
    "phaseFailed",
    "gateFailed",
  ])
    assert.equal(attemptOutcome({ attempt: 2, operationStatus }), "failed");
});
test("HTTP hidden secret representation and unrelated metadata normalize without blocking", async () => {
  const h = await setup({
    afterPut(r) {
      delete r.variables.credential!.value;
      r.variables.credential!.allowOverride = true;
    },
  });
  const p = await h.engine.plan("integration-mode", "simulated");
  assert.equal((await h.engine.applyFromReview(p.id)).state, "tracking");
  assert.equal(h.count("PATCH"), 1);
});
test("HTTP attempt id and deploymentId remain distinct as Azure adds metadata", async () => {
  const h = await setup();
  const p = await h.engine.plan("integration-mode", "simulated");
  await h.engine.applyFromReview(p.id);
  h.observe("inProgress");
  await h.engine.refresh(p.id);
  h.release().environments[0]!.deploySteps[1]!.deploymentId = 400;
  assert.equal((await h.engine.refresh(p.id)).state, "tracking");
  h.release().environments[0]!.deploySteps[1]!.status = "succeeded";
  const r = await h.engine.refresh(p.id);
  assert.equal(r.state, "succeeded");
  assert.equal(r.observedAttemptId, 32);
  assert.equal(r.observedDeploymentId, 400);
});
test("local cancellation owns the release lock until its record is saved", async () => {
  const h = await setup();
  const p = await h.engine.plan("integration-mode", "simulated");
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const put = h.store.put.bind(h.store);
  h.store.put = async (r) => {
    if (r.state === "cancelled") {
      started();
      await gate;
    }
    await put(r);
  };
  const cancel = h.engine.cancel(p.id);
  await entered;
  try {
    await assert.rejects(h.engine.applyFromReview(p.id), { code: "BUSY" });
  } finally {
    release();
    await cancel;
  }
  assert.equal((await h.engine.get(p.id)).state, "cancelled");
  assert.equal(h.count("PUT") + h.count("PATCH"), 0);
});
