# Azure DevOps Classic Workbench

A desktop VS Code extension for reviewed Azure DevOps Classic Release operations. Copilot is the primary conversational entry point; every supported workflow is also available from the Workbench panel. The extension packages its runtime and dependencies: end users do not install Node, run npm, clone a repository or compile code.

## Install and start

1. In VS Code 1.105 or later, choose **Extensions → … → Install from VSIX** and select the supplied VSIX.
2. Run **Azure DevOps Classic: Open Workbench**, or open the Classic Releases activity bar entry.
3. Trust the workspace, add a connection and enter your PAT or manual bearer token in the protected VS Code input. Credentials are stored in SecretStorage, never in YAML or the chat.
4. Connect the profile and use **Probar conexión**. For corporate TLS, select a PEM CA bundle under **Certificado / proxy** before connecting. HTTP(S) proxies must not contain embedded credentials.
5. Import your existing operations YAML, inspect it and explicitly save it. Or use the new-operation wizard and then adjust advanced settings in YAML.
6. Prepare a plan, inspect its release, stage, artifacts, variable scopes and diff. Writes and approval decisions are disabled by default. Enable reviewed writes explicitly when ready, and confirm the reviewed plan.

Install a single coordinator. Stop the previous standalone MCP/Inspector before operating with the extension. Closing VS Code does not cancel a deployment already requested in Azure.

## Copilot

VS Code discovers **Azure DevOps Classic Workbench** through its official MCP provider. Authorize it when prompted and select its tools in Copilot. The extension does not manage your Copilot subscription or sign-in.

Try: “List my configured operations, prepare the selected mode and open its review in Workbench. Do not use the terminal to apply changes.”

The chat can consult Azure, prepare plans, inspect status, prepare rollback, open configuration and propose complete YAML drafts. Saving a draft and applying changes remain explicit panel actions. There is no MCP apply tool. Tokens must never be pasted into chat.

Before connecting a profile, setup tools are available. After connecting, refresh/restart the MCP entry if the client has cached the tool list. Remove or stop a duplicate manual stdio MCP entry to avoid using the old server accidentally.

Other clients: use **Copilot y MCP → Configuración para otro cliente MCP**. After explicit confirmation, the extension opens an unsaved JSON document containing the loopback URL and a temporary session credential, not your Azure token. The client must support Streamable HTTP and custom headers; adapt its configuration wrapper as needed. This is a compatibility configuration, not automatic installation into every client. Restarting VS Code rotates the endpoint/credential.

## Features

- Multiple private connection profiles, secure credential replacement, CA/proxy configuration and connection checks.
- Queries for configured/discovered organizations, projects, release definitions, environments, variables and release instances, including pagination and latest-release selection.
- YAML import/export, validation, comment-preserving editing, revision conflict detection and an assisted operation creator. Advanced configurations and multiple variable changes use the existing complete YAML schema.
- Shared planning, mandatory review, optional writes, exact attempt tracking, approvals, history, rollback and manual recovery.
- Strong pre-write fingerprints, bounded read-after-write verification, semantic invariants and no automatic PUT/PATCH retries.
- Authenticated loopback MCP, local-only webview assets, strict message validation and workspace trust gating.

The operation creator starts with one non-secret variable and two modes. Extend the YAML for multiple variables/modes, exact IDs, branch filters, downstream policy and the other existing options. Redeploy acts on the entire stage/environment, not an individual task inside it.

## History and recovery

History is encrypted in the extension's private global storage and bound to the owning connection. One coordinator holds the store lock. Unresolved executions block connection/credential changes until tracked or reconciled. Forgetting a token retains the profile and history so you can supply a replacement later.

To import legacy CLI history, stop the CLI and choose **Importar historial CLI** for the owning connection. Import requires an empty destination, locks both stores, retains the original files and uses an incomplete-import marker. If interrupted, reconnect is blocked; resume with the same source and profile. Do not delete keys, encrypted records or locks without understanding which process owns them. Plans from the legacy runtime must be recreated; historical rollback may be rejected by the bound catalog hash, requiring a fresh reviewed operation.

There is no distributed lock across machines or different state directories. Do not run the old CLI against its original state while using the imported history in the extension. Restoring a catalog backup does not automatically reconcile an uncertain deployment.

## Scope and limitations

Desktop VS Code is the supported target. Web VS Code, remote workspaces, containers, WSL, SSH and Codespaces have not been validated for this release; use a local desktop workspace. Bearer tokens are manual and are not refreshed automatically. A successful connection check does not prove deployment/approval permissions. TLS errors remain enforced: certificate validation is never disabled.

Review protects against accidental model writes, not malicious software running as the same OS user. SecretStorage holds Azure credentials; existing execution-store encryption uses a local key file. No telemetry or remote UI assets are added.

The panel remains usable without Copilot. Live progress is displayed in the panel; the chat can query status but is not promised unsolicited messages.

## Development

The parent repository builds and tests this extension. The publisher identifier is a local packaging identifier, not a claim of a registered Marketplace publisher. No automatic publishing is configured.
