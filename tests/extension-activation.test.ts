import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
test("extension entrypoint activates provider and panel; setup MCP has no apply tool or credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "extension-activation-"));
  const mockPath = join(dir, "vscode.cjs");
  const source = `class EventEmitter { constructor(){this.event=()=>({dispose(){}})} fire(){} dispose(){} }
 class Uri { constructor(value){this.value=value;this.fsPath=value} toString(){return this.value} static parse(v){return new Uri(v)} static joinPath(uri,...parts){return new Uri(uri.value+'/'+parts.join('/'))} static from(v){return new Uri(v.scheme+'://'+v.authority+v.path)} }
 class McpHttpServerDefinition { constructor(label,uri,headers,version){Object.assign(this,{label,uri,headers,version})} }
 const registry={}; const disposable={dispose(){}}; const webview={cspSource:'vscode-webview:',asWebviewUri:u=>u,postMessage:async()=>true,onDidReceiveMessage:()=>disposable,html:''};
 module.exports={registry,webview,Uri,EventEmitter,McpHttpServerDefinition,ViewColumn:{One:1},TreeItem:class{},ThemeIcon:class{},env:{uriScheme:'vscode'},workspace:{isTrusted:true,onDidGrantWorkspaceTrust:()=>disposable},commands:{registerCommand:(id,fn)=>{registry[id]=fn;return disposable}},lm:{registerMcpServerDefinitionProvider:(id,provider)=>{registry.provider=provider;return disposable}},window:{createOutputChannel:()=>({appendLine(){},dispose(){}}),registerTreeDataProvider:()=>disposable,registerUriHandler:()=>disposable,createWebviewPanel:()=>({webview,onDidDispose:()=>disposable,dispose(){},reveal(){}})}};`;
  await writeFile(mockPath, source);
  const outfile = join(dir, "extension.cjs");
  await build({
    entryPoints: [resolve("extension/src/extension.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["vscode"],
    logLevel: "silent",
  });
  // Resolve the runtime's only application external exactly as VS Code would.
  const mockModule = join(dir, "node_modules", "vscode");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(mockModule, { recursive: true });
  await writeFile(join(mockModule, "index.js"), source);
  const require = createRequire(import.meta.url),
    extension = require(outfile),
    vscode = require(join(mockModule, "index.js"));
  const context = {
    globalStorageUri: { fsPath: join(dir, "storage") },
    extensionUri: new vscode.Uri("extension"),
    extension: { id: "local-classic-workbench.azure-devops-classic-workbench" },
    subscriptions: [],
    globalState: { get: (_k: string, fallback: unknown) => fallback },
  };
  const client = new Client({ name: "test", version: "1" });
  try {
    const api = await extension.activate(context);
    assert.equal((await api.snapshot()).active, undefined);
    api.open();
    assert.match(vscode.webview.html, /Content-Security-Policy/);
    assert.match(vscode.webview.html, /nonce-/);
    assert.ok(!vscode.webview.html.includes("TOKEN_SENTINEL"));
    const defs = vscode.registry.provider.provideMcpServerDefinitions();
    assert.equal(defs.length, 1);
    assert.deepEqual(defs[0].headers, {});
    const definition = vscode.registry.provider.resolveMcpServerDefinition(
      defs[0],
    );
    assert.match(definition.headers.Authorization, /^Bearer [a-f0-9]{64}$/);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(definition.uri.toString()), {
        requestInit: { headers: definition.headers },
      }),
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("ado_workbench_open"));
    assert.ok(names.includes("ado_workbench_draft_operation"));
    assert.ok(!names.some((n) => /apply|decide|approve/.test(n)));
  } finally {
    await client.close();
    await extension.deactivate();
    await rm(dir, { recursive: true, force: true });
  }
});
