import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import type { Workbench } from "../extension/src/workbench.js";
import type * as VSCode from "vscode";
import { fixtureRelease } from "./fixtures/extension-release.js";
test("bundled Workbench: credentials stay private, shared panel/MCP runtime, permissions and pinned review", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workbench-contract-"));
  const answers: string[] = [];
  const values = new Map<string, unknown>(),
    secrets = new Map<string, string>(),
    logs: string[] = [];
  const trust = { isTrusted: true };
  const mock = {
    workspace: trust,
    env: { uriScheme: "vscode" },
    Uri: {
      from: (x: { scheme: string; authority: string; path: string }) => ({
        toString: () => `${x.scheme}://${x.authority}${x.path}`,
      }),
    },
    window: {
      showInputBox: async () => answers.shift(),
      showQuickPick: async () => answers.shift(),
      showWarningMessage: async () => answers.shift(),
    },
  };
  (globalThis as unknown as { mockVscode: unknown }).mockVscode = mock;
  const outfile = join(dir, "workbench.cjs");
  await build({
    entryPoints: [resolve("extension/src/workbench.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    alias: { vscode: resolve("extension/test/mock-vscode.ts") },
    logLevel: "silent",
  });
  const { Workbench: Host } = createRequire(import.meta.url)(outfile) as {
    Workbench: typeof Workbench;
  };
  const context = {
    globalStorageUri: { fsPath: join(dir, "storage") },
    extension: { id: "local-classic-workbench.azure-devops-classic-workbench" },
    globalState: {
      get: (key: string, fallback: unknown) =>
        values.has(key) ? structuredClone(values.get(key)) : fallback,
      update: async (key: string, value: unknown) => {
        values.set(key, structuredClone(value));
      },
    },
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => {
        secrets.set(key, value);
      },
      delete: async (key: string) => {
        secrets.delete(key);
      },
    },
  } as unknown as VSCode.ExtensionContext;
  let release = fixtureRelease(),
    writes = 0,
    deploys = 0;
  const fetcher: typeof fetch = async (input, init) => {
    assert.match(
      String(init?.headers && new Headers(init.headers).get("Authorization")),
      /^Basic /,
    );
    const url = new URL(String(input));
    if (init?.method === "PUT") {
      writes++;
      release = JSON.parse(String(init.body));
      return new Response(null, { status: 204 });
    }
    if (init?.method === "PATCH") {
      deploys++;
      release.environments[0]!.deploySteps.push({
        attempt: 2,
        status: "succeeded",
      });
      return new Response(null, { status: 202 });
    }
    if (url.pathname.endsWith("/projects"))
      return new Response(JSON.stringify({ value: [] }));
    if (url.pathname.endsWith("/approvals"))
      return new Response(JSON.stringify({ value: [] }));
    return new Response(JSON.stringify(release));
  };
  const host = new Host(
    context,
    {
      appendLine: (text: string) => logs.push(text),
    } as unknown as VSCode.OutputChannel,
    async () => ({ fetcher, close: async () => {} }),
  );
  try {
    answers.push(
      "Example profile",
      "example-org",
      "Example Project",
      "pat",
      "TOKEN_SENTINEL",
    );
    await host.run(() => host.addProfile());
    const p = host.profiles()[0]!;
    assert.equal(secrets.get(`connection.${p.id}`), "TOKEN_SENTINEL");
    assert.ok(!JSON.stringify([...values]).includes("TOKEN_SENTINEL"));
    await host.run(() => host.connect(p.id));
    await host.run(() => host.testConnection());
    const catalog = await host.catalogRead();
    const yaml =
      'schemaVersion: "1"\ntargets:\n  test:\n    organization: example-org\n    project: Example Project\n    definitionId: 123\n    environment:\n      definitionEnvironmentId: 456\n      expectedName: Deploy Certification\n    selection:\n      strategy: explicit\n      releaseId: 987\noperations:\n  toggle:\n    description: Example change\n    target: test\n    modes: [enabled]\n    variables:\n      - name: integration-enabled\n        scope: release\n        values: {enabled: "true"}\n    deployment: {strategy: environmentRedeploy}\n';
    await host.run(() => host.stageDraft(yaml, catalog.revision));
    assert.equal((await host.catalogRead()).text, catalog.text);
    await host.run(() => host.saveCatalog(yaml, catalog.revision));
    const first = await host.run(() => host.plan("toggle", "enabled"));
    answers.push("Apply");
    await assert.rejects(
      host.run(() => host.executionAction("apply", first.id, undefined)),
      { code: "WRITES_DISABLED" },
    );
    assert.equal(writes, 0);
    answers.push("Enable");
    await host.run(() => host.permissions("writes"));
    const planned = await host.run(() => host.plan("toggle", "enabled"));
    answers.push("Apply");
    await host.run(() => host.executionAction("apply", planned.id, undefined));
    assert.equal(writes, 1);
    assert.equal(deploys, 1);
    await assert.rejects(
      host.run(() => host.rotate(p.id)),
      { code: "UNRESOLVED_EXECUTION" },
    );
    const done = await host.coordinator.engine.refresh(planned.id);
    assert.equal(done.state, "succeeded");
    assert.equal((await host.execution(planned.id)).id, planned.id);
    const server = host.mcpServer();
    assert.ok(server);
    await server.close();
    trust.isTrusted = false;
    await assert.rejects(
      host.run(() => host.testConnection()),
      { code: "WORKSPACE_UNTRUSTED" },
    );
    trust.isTrusted = true;
    assert.ok(!JSON.stringify(logs).includes("TOKEN_SENTINEL"));
    assert.ok(
      !JSON.stringify(await host.snapshot()).includes("TOKEN_SENTINEL"),
    );
  } finally {
    await host.close();
    delete (globalThis as unknown as { mockVscode?: unknown }).mockVscode;
    await rm(dir, { recursive: true, force: true });
  }
});
