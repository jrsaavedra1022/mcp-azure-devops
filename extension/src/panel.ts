import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../src/errors.js";
import { parseCatalog } from "../../src/operations/catalog.js";
import type { Workbench, View } from "./workbench.js";
export class Panel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private subscription: vscode.Disposable;
  private target: { view: View; executionId?: string } = { view: "operations" };
  constructor(
    private host: Workbench,
    private integration: () => Promise<unknown>,
  ) {
    this.subscription = host.changed.event(() => {
      void this.panel?.webview.postMessage({ event: "refresh" });
    });
  }
  open(view: View = "operations", executionId?: string) {
    this.target = { view, executionId };
    if (this.panel) {
      this.panel.reveal();
      void this.panel.webview.postMessage({
        event: "navigate",
        ...this.target,
      });
      return;
    }
    const media = vscode.Uri.joinPath(this.host.context.extensionUri, "media");
    const panel = vscode.window.createWebviewPanel(
      "classicWorkbench",
      "Azure DevOps Classic",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [media],
        retainContextWhenHidden: true,
      },
    );
    this.panel = panel;
    const nonce = randomBytes(24).toString("hex"),
      script = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "app.js")),
      style = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(media, "style.css"),
      );
    panel.webview.html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${panel.webview.cspSource}; base-uri 'none'; form-action 'none'"><link rel="stylesheet" href="${style}"><title>Classic Workbench</title></head><body><header><div><span class="eyebrow">AZURE DEVOPS</span><h1>Classic Workbench</h1><p>Operaciones revisadas. Un mismo flujo desde Copilot o el panel.</p></div><span id="connection" class="badge">Sin conexión</span></header><nav aria-label="Secciones" id="tabs"></nav><div id="notice" role="status" aria-live="polite"></div><main id="content"></main><footer>Los secretos se ingresan en VS Code. Un redeploy ejecuta el stage completo.</footer><script nonce="${nonce}" src="${script}"></script></body></html>`;
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
    });
    panel.webview.onDidReceiveMessage(async (raw: unknown) => {
      let requestId: number | undefined;
      try {
        const message = z
          .object({
            id: z.number().int(),
            action: z.string().max(40),
            data: z.unknown().optional(),
            profileId: z.string().optional(),
          })
          .strict()
          .parse(raw);
        requestId = message.id;
        if (message.action === "ready") {
          await panel.webview.postMessage({
            event: "navigate",
            ...this.target,
          });
        }
        const execute = async () => {
          const disconnected = new Set([
            "snapshot",
            "ready",
            "addProfile",
            "connect",
            "rotate",
            "remove",
            "network",
            "editProfile",
            "importHistory",
            "integration",
          ]);
          if (
            !disconnected.has(message.action) &&
            message.profileId !== this.host.profile?.id
          )
            throw new AppError(
              "PROFILE_MISMATCH",
              "Connection changed. Reload the view before continuing.",
            );
          const data = message.data;
          switch (message.action) {
            case "ready":
            case "snapshot":
              return this.host.snapshot();
            case "addProfile":
              return this.host.addProfile();
            case "connect":
              return this.host.connect(z.string().uuid().parse(data));
            case "stop":
              return this.host.stop();
            case "rotate":
              return this.host.rotate(z.string().uuid().parse(data));
            case "remove":
              return this.host.remove(z.string().uuid().parse(data));
            case "editProfile":
              return this.host.editProfile(z.string().uuid().parse(data));
            case "importHistory":
              return this.host.importHistory(z.string().uuid().parse(data));
            case "network":
              return this.host.networkSettings(z.string().uuid().parse(data));
            case "testConnection":
              return this.host.testConnection();
            case "permissions":
              return this.host.permissions(
                z.enum(["writes", "approvals"]).parse(data),
              );
            case "catalog":
              return this.host.catalogRead();
            case "discardDraft":
              this.host.draft = undefined;
              return;
            case "import":
              return this.host.importCatalog();
            case "export":
              return this.host.exportCatalog();
            case "wizard":
              return this.host.wizard();
            case "validate":
              parseCatalog(z.string().parse(data));
              return { valid: true };
            case "save": {
              const d = z
                .object({
                  text: z.string().max(262144),
                  revision: z.string().length(64),
                })
                .strict()
                .parse(data);
              return this.host.saveCatalog(d.text, d.revision);
            }
            case "plan": {
              const d = z
                .object({ operation: z.string(), mode: z.string() })
                .strict()
                .parse(data);
              return this.host.plan(d.operation, d.mode);
            }
            case "execution":
              return this.host.execution(z.string().uuid().parse(data));
            case "executionAction": {
              const d = z
                .object({
                  action: z.enum([
                    "apply",
                    "cancel",
                    "rollback",
                    "recover",
                    "approval",
                  ]),
                  executionId: z.string().uuid(),
                  args: z.unknown().optional(),
                })
                .strict()
                .parse(data);
              return this.host.executionAction(d.action, d.executionId, d.args);
            }
            case "explore":
              return this.host.explore(data);
            case "integration":
              return this.integration();
            default:
              throw new AppError("INVALID_ACTION", "Unknown panel action.");
          }
        };
        const response = ["snapshot", "ready"].includes(message.action)
          ? await execute()
          : await this.host.run(
              execute,
              !["execution", "catalog"].includes(message.action),
            );
        await panel.webview.postMessage({
          id: requestId,
          result: response ?? null,
        });
      } catch (e) {
        await panel.webview.postMessage({
          id: requestId,
          error: this.host.report(e),
        });
      }
    });
  }
  dispose() {
    this.subscription.dispose();
    this.panel?.dispose();
  }
}
