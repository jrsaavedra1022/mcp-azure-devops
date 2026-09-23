import * as vscode from "vscode";
import { startMcpHttp } from "../../src/mcp-http.js";
import { Workbench, type View } from "./workbench.js";
import { Panel } from "./panel.js";
let cleanup: (() => Promise<void>) | undefined;
export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel(
    "Azure DevOps Classic Workbench",
  );
  const host = new Workbench(context, output);
  let endpoint: Awaited<ReturnType<typeof startMcpHttp>> | undefined;
  const panel = new Panel(host, async () => {
    if (!endpoint) throw Error("MCP unavailable");
    if (
      (await vscode.window.showWarningMessage(
        "Show a temporary local MCP session credential for another client? Do not share or commit it. VS Code must remain open.",
        { modal: true },
        "Show configuration",
      )) !== "Show configuration"
    )
      return { message: "Cancelled" };
    const doc = await vscode.workspace.openTextDocument({
      language: "json",
      content: JSON.stringify(
        {
          servers: {
            "azure-devops-classic-workbench": {
              type: "http",
              url: endpoint.url,
              headers: { Authorization: `Bearer ${endpoint.token}` },
            },
          },
        },
        null,
        2,
      ),
    });
    await vscode.window.showTextDocument(doc);
    return {
      message:
        "Temporary configuration opened. Adapt the wrapper for your client's MCP format. This session expires when VS Code closes.",
    };
  });
  host.openView = (view, executionId) => panel.open(view, executionId);
  const start = async () => {
    if (!vscode.workspace.isTrusted || endpoint) return;
    endpoint = await startMcpHttp(
      () => host.mcpServer(),
      (action) => host.mcpRequest(action),
    );
    host.definitionsChanged.fire();
  };
  context.subscriptions.push(
    output,
    panel,
    host.changed,
    host.definitionsChanged,
    vscode.commands.registerCommand("classicWorkbench.open", () =>
      panel.open(),
    ),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void start().catch((e) => vscode.window.showErrorMessage(host.report(e)));
    }),
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        const review = /^\/review\/([a-f0-9-]{36})$/.exec(uri.path);
        const view =
          /^\/view\/(connections|catalog|operations|history|explore|integration)$/.exec(
            uri.path,
          );
        if (review) {
          panel.open("history", review[1]);
        } else if (view) {
          panel.open(view[1] as View);
        } else panel.open();
      },
    }),
    vscode.window.registerTreeDataProvider("classicWorkbench.launcher", {
      getTreeItem: (item: vscode.TreeItem) => item,
      getChildren: () => {
        const item = new vscode.TreeItem("Open Classic Workbench");
        item.command = { command: "classicWorkbench.open", title: "Open" };
        item.iconPath = new vscode.ThemeIcon("rocket");
        return [item];
      },
    }),
    vscode.lm.registerMcpServerDefinitionProvider("classicWorkbench.mcp", {
      onDidChangeMcpServerDefinitions: host.definitionsChanged.event,
      provideMcpServerDefinitions: () =>
        endpoint
          ? [
              new vscode.McpHttpServerDefinition(
                "Azure DevOps Classic Workbench",
                vscode.Uri.parse(endpoint.url),
                {},
                `0.1.0-${host.profile?.id ?? "setup"}-${host.profile?.revision ?? 0}`,
              ),
            ]
          : [],
      resolveMcpServerDefinition: (definition) => {
        if (!vscode.workspace.isTrusted || !endpoint) return undefined;
        if (definition instanceof vscode.McpHttpServerDefinition) {
          definition.uri = vscode.Uri.parse(endpoint.url);
          definition.headers = { Authorization: `Bearer ${endpoint.token}` };
          return definition;
        }
        return undefined;
      },
    }),
  );
  cleanup = async () => {
    await endpoint?.close();
    await host.close();
  };
  await start();
  // No automatic connection, writes or credential prompts on startup.
  return {
    version: "0.1.0",
    open: () => panel.open(),
    snapshot: () => host.snapshot(),
  };
}
export async function deactivate() {
  await cleanup?.();
  cleanup = undefined;
}
