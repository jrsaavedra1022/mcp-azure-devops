import * as vscode from "vscode";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseDocument } from "yaml";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../../src/config.js";
import { AppError, safeError } from "../../src/errors.js";
import { RestClient } from "../../src/client/rest-client.js";
import { AzureDevOpsAdapter } from "../../src/adapters/azure-devops.js";
import { DevOpsService } from "../../src/services/devops-service.js";
import { ReleaseQueryService } from "../../src/services/release-query-service.js";
import { AzureReleaseGateway } from "../../src/operations/gateway.js";
import { EncryptedStore } from "../../src/operations/store.js";
import {
  createCoordinator,
  type Coordinator,
} from "../../src/operations/coordinator.js";
import { digest, parseCatalog } from "../../src/operations/catalog.js";
import { createServer } from "../../src/server.js";
import { toolResult } from "../../src/tools/register.js";
import {
  CatalogRepository,
  ConnectionStore,
  profileSchema,
  unresolved,
  type Profile,
  type BoundExecution,
} from "./model.js";
import { createNetwork } from "./network.js";
import { importLegacyState } from "./migration.js";
import { operationEditSchema, proposeOperationEdit } from "./catalog-edits.js";
const id = z.string().uuid();
const short = z.string().min(1).max(120);
export type View =
  | "connections"
  | "catalog"
  | "operations"
  | "history"
  | "explore"
  | "integration";
export class Workbench {
  readonly changed = new vscode.EventEmitter<void>();
  readonly definitionsChanged = new vscode.EventEmitter<void>();
  private pending = new Set<Promise<unknown>>();
  private controlBusy = false;
  private closing = false;
  private mcpRunning = 0;
  async mcpRequest(action: () => Promise<void>) {
    this.trust();
    if (this.controlBusy || this.closing)
      throw new AppError(
        "BUSY",
        "Workbench is changing configuration or executing a reviewed action.",
      );
    this.mcpRunning++;
    try {
      await action();
    } finally {
      this.mcpRunning--;
    }
  }
  private active?: {
    profile: Profile;
    coordinator: Coordinator;
    store: EncryptedStore<BoundExecution>;
    network: Awaited<ReturnType<typeof createNetwork>>;
    catalog: CatalogRepository;
    client: RestClient;
    reader: AzureDevOpsAdapter;
    gateway: AzureReleaseGateway;
    config: ReturnType<typeof loadConfig>;
  };
  draft?: { text: string; revision: string };
  openView: (view: View, executionId?: string) => void = () => {};
  constructor(
    readonly context: vscode.ExtensionContext,
    private output: vscode.OutputChannel,
    private networkFactory = createNetwork,
  ) {}
  private trust() {
    if (!vscode.workspace.isTrusted)
      throw new AppError(
        "WORKSPACE_UNTRUSTED",
        "Trust this workspace before configuring or connecting.",
      );
  }
  profiles(): Profile[] {
    return z
      .array(profileSchema)
      .parse(this.context.globalState.get("profiles", []));
  }
  get profile() {
    return this.active?.profile;
  }
  get coordinator() {
    if (!this.active)
      throw new AppError(
        "NOT_CONNECTED",
        "Connect a profile in the Workbench first.",
      );
    return this.active.coordinator;
  }
  private get connection() {
    if (!this.active)
      throw new AppError(
        "NOT_CONNECTED",
        "Connect a profile in the Workbench first.",
      );
    return this.active;
  }
  report(error: unknown) {
    const safe =
      error instanceof z.ZodError
        ? {
            code: "INVALID_INPUT",
            message: "Check required fields, numeric IDs and allowed options.",
            status: undefined,
          }
        : safeError(error);
    this.output.appendLine(
      JSON.stringify({
        event: "operation_error",
        code: safe.code,
        status: safe.status,
      }),
    );
    return `${safe.code}: ${safe.message}`;
  }
  url(view: View = "operations", executionId?: string) {
    return vscode.Uri.from({
      scheme: vscode.env.uriScheme,
      authority: this.context.extension.id,
      path: executionId ? `/review/${executionId}` : `/view/${view}`,
    }).toString();
  }
  /** All user controllers participate in shutdown; configuration never races another panel action. */
  async run<T>(action: () => Promise<T>, exclusive = true): Promise<T> {
    this.trust();
    if (this.closing)
      throw new AppError("SHUTTING_DOWN", "Workbench is stopping.");
    if (exclusive && this.controlBusy)
      throw new AppError("BUSY", "Wait for the current action to finish.");
    if (exclusive) this.controlBusy = true;
    const promise = Promise.resolve().then(action);
    this.pending.add(promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(promise);
      if (exclusive) {
        this.controlBusy = false;
        this.changed.fire();
      }
    }
  }
  async snapshot() {
    const active = this.active;
    return {
      trusted: vscode.workspace.isTrusted,
      profiles: this.profiles(),
      active: active?.profile.id,
      capabilities: active?.coordinator.engine.reviewCapabilities(),
      operations: active
        ? await active.coordinator.engine.listOperations()
        : [],
      executions: active ? await active.coordinator.engine.list() : [],
      busy: this.controlBusy,
    };
  }
  async addProfile() {
    const name = await vscode.window.showInputBox({
      title: "Connection name",
      ignoreFocusOut: true,
    });
    if (!name) return;
    const organization = await vscode.window.showInputBox({
      title: "Azure DevOps organization (short name)",
      ignoreFocusOut: true,
    });
    if (!organization) return;
    const project = await vscode.window.showInputBox({
      title: "Azure DevOps project",
      ignoreFocusOut: true,
    });
    if (!project) return;
    const auth = await vscode.window.showQuickPick(["pat", "bearer"], {
      title: "Credential type (manual token)",
    });
    if (!auth) return;
    const profile = profileSchema.parse({
      id: randomUUID(),
      name,
      organization,
      project,
      auth,
      revision: 0,
    });
    const credential = await vscode.window.showInputBox({
      title: "Credential — stored in VS Code SecretStorage",
      password: true,
      ignoreFocusOut: true,
    });
    if (!credential?.trim()) return;
    await this.context.secrets.store(
      `connection.${profile.id}`,
      credential.trim(),
    );
    try {
      await this.context.globalState.update("profiles", [
        ...this.profiles(),
        profile,
      ]);
    } catch (e) {
      await this.context.secrets.delete(`connection.${profile.id}`);
      throw e;
    }
  }
  private async ensureIdle(inspectStored = true) {
    if (this.mcpRunning)
      throw new AppError(
        "BUSY",
        "Wait for the current MCP request before changing connection settings.",
      );
    if (
      this.active &&
      (await this.active.store.list()).some((r) => unresolved.has(r.state))
    )
      throw new AppError(
        "UNRESOLVED_EXECUTION",
        "Finish tracking or reconcile unresolved executions before changing connection or permissions.",
      );
    if (!this.active && inspectStored) {
      const store = new EncryptedStore<BoundExecution>(
        join(this.context.globalStorageUri.fsPath, "state"),
      );
      await store.open();
      try {
        if ((await store.list()).some((r) => unresolved.has(r.state)))
          throw new AppError(
            "UNRESOLVED_EXECUTION",
            "Reconnect the owning profile and reconcile before changing credentials or configuration.",
          );
      } finally {
        await store.close();
      }
    }
  }
  async connect(profileId: string) {
    id.parse(profileId);
    await this.ensureIdle(false);
    const profile = this.profiles().find((p) => p.id === profileId);
    if (!profile)
      throw new AppError("PROFILE_MISSING", "Connection unavailable.");
    const credential = await this.context.secrets.get(
      `connection.${profile.id}`,
    );
    if (!credential)
      throw new AppError(
        "CREDENTIAL_MISSING",
        "Replace the credential for this connection.",
      );
    await this.disconnect();
    const config = loadConfig({
      [profile.auth === "pat" ? "AZDO_PAT" : "AZDO_BEARER_TOKEN"]: credential,
      AZDO_ORGANIZATION: profile.organization,
      AZDO_PROJECT: profile.project,
      AZDO_ALLOWED_ORGANIZATIONS: profile.organization,
    });
    const catalog = new CatalogRepository(
      join(
        this.context.globalStorageUri.fsPath,
        "catalogs",
        profile.id + ".yaml",
      ),
    );
    await catalog.initialize();
    const network = await this.networkFactory(profile);
    const client = new RestClient(
      config,
      (event, status) =>
        this.output.appendLine(JSON.stringify({ event, status })),
      network.fetcher,
    );
    const reader = new AzureDevOpsAdapter(client),
      gateway = new AzureReleaseGateway(client);
    const store = new EncryptedStore<BoundExecution>(
      join(this.context.globalStorageUri.fsPath, "state"),
    );
    try {
      await store.open();
      const bound = new ConnectionStore(store, profile.id);
      await bound.ensureAvailable();
      const coordinator = await createCoordinator({
        gateway,
        store: bound,
        allowed: config.allowedOrganizations,
        catalog: async () => {
          const c = await catalog.read();
          return {
            catalog: c.catalog,
            hash: digest({
              catalog: c.hash,
              profile: profile.id,
              revision: profile.revision,
            }),
          };
        },
        writes: this.context.globalState.get(`writes.${profile.id}`, false),
        approvalWrites: this.context.globalState.get(
          `approvals.${profile.id}`,
          false,
        ),
        review: async () => ({
          url: (executionId) => this.url("history", executionId),
          close: async () => {},
        }),
        onRefresh: () => this.changed.fire(),
      });
      this.active = {
        profile,
        coordinator,
        store,
        network,
        catalog,
        client,
        reader,
        gateway,
        config,
      };
      await this.context.globalState.update("lastProfile", profile.id);
      this.draft = undefined;
      this.definitionsChanged.fire();
      this.changed.fire();
    } catch (e) {
      await store.close();
      await network.close();
      throw e;
    }
  }
  private async disconnect() {
    const a = this.active;
    if (!a) return;
    this.active = undefined;
    await a.coordinator.close();
    await a.store.close();
    await a.network.close();
    this.definitionsChanged.fire();
  }
  async stop() {
    await this.ensureIdle();
    await this.disconnect();
  }
  async rotate(profileId: string) {
    id.parse(profileId);
    await this.ensureIdle();
    const profiles = this.profiles(),
      p = profiles.find((p) => p.id === profileId);
    if (!p) throw new AppError("PROFILE_MISSING", "Connection unavailable.");
    const credential = await vscode.window.showInputBox({
      title: "New credential (pending plans will be invalidated)",
      password: true,
      ignoreFocusOut: true,
    });
    if (!credential?.trim()) return;
    const reconnect = this.profile?.id === p.id;
    if (reconnect) await this.disconnect();
    p.revision++;
    await this.context.globalState.update("profiles", profiles);
    await this.context.secrets.store(`connection.${p.id}`, credential.trim());
    if (reconnect) await this.connect(p.id);
  }
  async remove(profileId: string) {
    id.parse(profileId);
    await this.ensureIdle();
    if (
      (await vscode.window.showWarningMessage(
        "Forget this credential? The connection and encrypted execution history are retained.",
        { modal: true },
        "Remove",
      )) !== "Remove"
    )
      return;
    if (this.profile?.id === profileId) await this.disconnect();
    await this.context.secrets.delete(`connection.${profileId}`);
  }
  async permissions(kind: "writes" | "approvals") {
    await this.ensureIdle();
    const p = this.connection.profile;
    const current = this.context.globalState.get(`${kind}.${p.id}`, false);
    if (
      !current &&
      (await vscode.window.showWarningMessage(
        kind === "writes"
          ? "Enable reviewed Azure writes for this connection?"
          : "Enable explicit approval decisions for this connection? Azure still enforces your permissions.",
        { modal: true },
        "Enable",
      )) !== "Enable"
    )
      return;
    await this.context.globalState.update(`${kind}.${p.id}`, !current);
    await this.connect(p.id);
  }
  async networkSettings(profileId: string) {
    await this.ensureIdle();
    const profiles = this.profiles(),
      p = profiles.find((p) => p.id === id.parse(profileId));
    if (!p) throw new AppError("PROFILE_MISSING", "Connection unavailable.");
    const choice = await vscode.window.showQuickPick(
      [
        "Choose PEM CA bundle",
        "Set proxy URL",
        "Clear custom network settings",
      ],
      { title: "Network settings for " + p.name },
    );
    if (!choice) return;
    if (choice === "Choose PEM CA bundle") {
      const file = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { Certificates: ["pem", "crt"] },
      });
      if (!file?.[0]) return;
      if (file[0].scheme !== "file")
        throw new AppError(
          "LOCAL_FILE_REQUIRED",
          "Select a local certificate file.",
        );
      p.caFile = file[0].fsPath;
    }
    if (choice === "Set proxy URL") {
      const proxy = await vscode.window.showInputBox({
        title: "HTTP(S) proxy URL without embedded credentials",
        value: p.proxy,
      });
      if (proxy === undefined) return;
      p.proxy = proxy || undefined;
    }
    if (choice === "Clear custom network settings") {
      delete p.proxy;
      delete p.caFile;
    }
    profileSchema.parse(p);
    p.revision++;
    await this.context.globalState.update("profiles", profiles);
    if (this.profile?.id === p.id) await this.connect(p.id);
  }
  async editProfile(profileId: string) {
    await this.ensureIdle();
    const profiles = this.profiles(),
      p = profiles.find((p) => p.id === id.parse(profileId));
    if (!p) throw new AppError("PROFILE_MISSING", "Connection unavailable.");
    const name = await vscode.window.showInputBox({
      title: "Connection name",
      value: p.name,
    });
    if (name === undefined) return;
    // Identity remains stable for history. Different organizations/projects use a new profile.
    p.name = z.string().trim().min(1).max(80).parse(name);
    await this.context.globalState.update("profiles", profiles);
    if (this.profile?.id === p.id) this.active!.profile.name = p.name;
  }
  async importHistory(profileId: string) {
    await this.ensureIdle(false);
    const p = this.profiles().find((p) => p.id === id.parse(profileId));
    if (!p) throw new AppError("PROFILE_MISSING", "Connection unavailable.");
    const folder = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      title: "Legacy CLI encrypted state directory (stop the CLI first)",
    });
    if (!folder?.[0]) return;
    if (folder[0].scheme !== "file")
      throw new AppError(
        "LOCAL_FILE_REQUIRED",
        "Select a local state directory.",
      );
    if (
      (await vscode.window.showWarningMessage(
        "Import encrypted history into an empty extension store? Stop the CLI first and use only this extension afterwards. Original files remain unchanged. Pending plans must be recreated.",
        { modal: true },
        "Import",
      )) !== "Import"
    )
      return;
    await this.disconnect();
    const count = await importLegacyState(
      folder[0].fsPath,
      join(this.context.globalStorageUri.fsPath, "state"),
      p.id,
    );
    return {
      message: `Imported ${count} executions. Connect the profile to inspect history and reconcile interrupted operations.`,
    };
  }
  async testConnection() {
    const a = this.connection;
    const result = await new DevOpsService(a.config, a.reader).projects(
      {},
      { top: 1 },
    );
    return {
      ok: true,
      message:
        "Azure connection succeeded with this profile. Deployment permissions must still be verified.",
      result,
    };
  }
  async catalogRead() {
    const c = await this.connection.catalog.read();
    return { text: c.text, revision: c.revision, draft: this.draft };
  }
  async stageDraft(text: string, revision: string) {
    if (this.draft && this.draft.text !== text)
      throw new AppError(
        "DRAFT_PENDING",
        "Review or discard the current catalog draft first.",
      );
    z.string().max(262144).parse(text);
    parseCatalog(text);
    const c = await this.connection.catalog.read();
    if (c.revision !== revision)
      throw new AppError(
        "CATALOG_CONFLICT",
        "Reload the catalog before proposing changes.",
      );
    this.draft = { text, revision };
    this.openView("catalog");
    return {
      status: "draft",
      reviewUrl: this.url("catalog"),
      message:
        "Draft only. User must review and save in Workbench; no Azure writes.",
    };
  }
  async saveCatalog(text: string, revision: string) {
    await this.connection.catalog.save(text, revision);
    this.draft = undefined;
  }
  async importCatalog() {
    const file = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { YAML: ["yaml", "yml"] },
    });
    if (!file?.[0]) return;
    const text = Buffer.from(
      await vscode.workspace.fs.readFile(file[0]),
    ).toString("utf8");
    const c = await this.connection.catalog.read();
    await this.stageDraft(text, c.revision);
  }
  async exportCatalog() {
    const file = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file("operations.local.yaml"),
      filters: { YAML: ["yaml", "yml"] },
    });
    if (!file) return;
    const c = await this.connection.catalog.read();
    await vscode.workspace.fs.writeFile(file, Buffer.from(c.text));
  }
  async wizard() {
    const a = this.connection,
      c = await a.catalog.read();
    const key = await vscode.window.showInputBox({
      title: "Operation ID (unique, e.g. integration-mode)",
    });
    if (!key) return;
    if (c.catalog.operations[key])
      throw new AppError(
        "OPERATION_EXISTS",
        "Edit the existing operation in YAML instead of overwriting it.",
      );
    const definition = await vscode.window.showInputBox({
      title: "Exact release definition name",
    });
    if (!definition) return;
    const environment = await vscode.window.showInputBox({
      title: "Exact stage/environment name",
    });
    if (!environment) return;
    const variable = await vscode.window.showInputBox({
      title: "Non-secret variable name",
    });
    if (!variable) return;
    const scope = await vscode.window.showQuickPick(
      ["release", "environment"],
      { title: "Variable scope" },
    );
    if (!scope) return;
    const on = await vscode.window.showInputBox({
      title: "Value for mode enabled (visible string, never a secret)",
      value: "true",
    });
    if (on === undefined) return;
    const off = await vscode.window.showInputBox({
      title: "Value for mode disabled",
      value: "false",
    });
    if (off === undefined) return;
    const doc = parseDocument(c.text);
    const targetKey = key + "-target";
    if (c.catalog.targets[targetKey])
      throw new AppError("TARGET_EXISTS", "Choose a different operation ID.");
    doc.setIn(["targets", targetKey], {
      organization: a.profile.organization,
      project: a.profile.project,
      definition: { name: definition },
      environment: { name: environment },
      selection: { strategy: "latestCreated" },
    });
    doc.setIn(["operations", key], {
      description: `Update ${variable} and redeploy the selected stage`,
      target: targetKey,
      modes: ["enabled", "disabled"],
      variables: [
        {
          name: variable,
          scope,
          mustExist: true,
          values: { enabled: on, disabled: off },
        },
      ],
      deployment: {
        strategy: "environmentRedeploy",
        downstreamPolicy: "reject",
        redeployWhenUnchanged: false,
      },
      approvals: "external",
      planTtlMinutes: 15,
      trackingTimeoutMinutes: 1440,
    });
    await this.stageDraft(doc.toString(), c.revision);
  }
  async explore(input: unknown) {
    const a = this.connection,
      service = new DevOpsService(a.config, a.reader),
      releases = new ReleaseQueryService(a.config, a.gateway);
    const q = z
      .object({
        kind: z.enum([
          "organizations",
          "discoverOrganizations",
          "projects",
          "definitions",
          "definition",
          "environments",
          "variables",
          "releases",
          "release",
          "latest",
        ]),
        memberId: z.string().uuid().optional(),
        definitionId: z.number().int().positive().optional(),
        releaseId: z.number().int().positive().optional(),
        environmentId: z.number().int().positive().optional(),
        environmentName: z.string().optional(),
        searchText: z.string().optional(),
        continuationToken: z.string().max(4096).optional(),
        strategy: z
          .enum(["latestCreated", "latestSuccessfulDeployment"])
          .optional(),
        includeValues: z.boolean().default(false),
      })
      .strict()
      .parse(input);
    const page = { top: 50, continuationToken: q.continuationToken };
    switch (q.kind) {
      case "organizations":
        return service.organizations();
      case "discoverOrganizations":
        return service.discoverOrganizations(
          z.string().uuid().parse(q.memberId),
        );
      case "projects":
        return service.projects({}, page);
      case "definitions":
        return service.definitions({}, { ...page, searchText: q.searchText });
      case "definition":
        return service.definition({}, z.number().parse(q.definitionId));
      case "environments":
        return service.environments({}, z.number().parse(q.definitionId));
      case "variables":
        return service.variables(
          {},
          z.number().parse(q.definitionId),
          q.environmentId,
          q.includeValues,
        );
      case "releases":
        return releases.list({ definitionId: q.definitionId, ...page });
      case "release":
        return releases.get({ releaseId: q.releaseId });
      case "latest":
        return releases.latest({
          definitionId: q.definitionId,
          strategy: q.strategy ?? "latestCreated",
          environmentName: q.environmentName,
        });
    }
  }
  async execution(executionId: string) {
    return this.coordinator.engine.get(id.parse(executionId));
  }
  async plan(operation: string, mode: string) {
    const r = await this.coordinator.engine.plan(
      short.parse(operation),
      short.parse(mode),
    );
    this.openView("history", r.id);
    return { id: r.id };
  }
  async executionAction(
    action: "apply" | "cancel" | "rollback" | "recover" | "approval",
    executionId: string,
    data: unknown,
  ) {
    const engine = this.coordinator.engine;
    id.parse(executionId);
    if (action === "apply") {
      if (
        (await vscode.window.showWarningMessage(
          "Apply this reviewed plan to Azure and request its stage redeploy?",
          { modal: true },
          "Apply",
        )) !== "Apply"
      )
        return;
      await engine.applyFromReview(executionId);
    }
    if (action === "cancel") await engine.cancel(executionId);
    if (action === "rollback") {
      const r = await engine.planRollback(executionId);
      this.openView("history", r.id);
      return { id: r.id };
    }
    if (action === "recover") {
      if (
        (await vscode.window.showWarningMessage(
          "Have you reconciled variables and deployment attempts in Azure? This only releases the local block; it does not cancel or undo anything.",
          { modal: true },
          "Reconciled",
        )) !== "Reconciled"
      )
        return;
      await engine.acknowledgeRecovery(executionId);
    }
    if (action === "approval") {
      const d = z
        .object({
          approvalId: z.number().int().positive(),
          decision: z.enum(["approved", "rejected"]),
        })
        .strict()
        .parse(data);
      const comment = await vscode.window.showInputBox({
        title: "Approval decision comment",
        ignoreFocusOut: true,
      });
      if (!comment?.trim()) return;
      if (
        (await vscode.window.showWarningMessage(
          `Send ${d.decision} for approval ${d.approvalId}?`,
          { modal: true },
          "Confirm",
        )) !== "Confirm"
      )
        return;
      await engine.decideFromReview(
        executionId,
        d.approvalId,
        d.decision,
        comment,
      );
    }
  }
  mcpServer() {
    const a = this.active;
    const server = a
      ? createServer(a.config, a.reader, a.coordinator, a.gateway)
      : new McpServer({
          name: "azure-devops-classic-workbench",
          version: "0.1.0",
        });
    server.registerTool(
      "ado_workbench_open",
      {
        description:
          "Open the VS Code Workbench to configure credentials securely, edit catalog or review operations. Never ask for a token in chat.",
        inputSchema: {
          view: z
            .enum([
              "connections",
              "catalog",
              "operations",
              "history",
              "explore",
              "integration",
            ])
            .default("operations"),
          executionId: id.optional(),
        },
      },
      (args) =>
        toolResult(() =>
          this.run(async () => {
            if (args.executionId) await this.execution(args.executionId);
            this.openView(args.view, args.executionId);
            return { opened: true };
          }),
        ),
    );
    server.registerTool(
      "ado_workbench_connections",
      {
        description:
          "List configured connection names and the active profile, without credentials.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      () =>
        toolResult(() => ({
          active: this.profile?.id,
          connections: this.profiles().map((p) => ({
            id: p.id,
            name: p.name,
            organization: p.organization,
            project: p.project,
          })),
        })),
    );
    server.registerTool(
      "ado_workbench_catalog_summary",
      {
        description:
          "Get the catalog revision and operation/target structure. Values remain in local review. Use this revision when proposing a complete YAML draft; prefer opening the editor for existing values.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      () =>
        toolResult(async () => {
          const c = await this.connection.catalog.read();
          return {
            revision: c.revision,
            targets: c.catalog.targets,
            operations: Object.entries(c.catalog.operations).map(
              ([operation, o]) => ({
                operation,
                ...o,
                variables: o.variables.map((v) => ({
                  name: v.name,
                  scope: v.scope,
                  mustExist: v.mustExist,
                })),
              }),
            ),
          };
        }),
    );
    server.registerTool(
      "ado_workbench_draft_operation",
      {
        description:
          "Propose targeted changes to existing operation mode values or deployment policy, preserving the rest of the YAML. User must review and save in the panel. Does not modify Azure.",
        inputSchema: {
          ...operationEditSchema.shape,
          revision: z.string().length(64),
        },
      },
      (args) =>
        toolResult(() =>
          this.run(async () => {
            const { revision, ...edit } = args;
            const current = await this.connection.catalog.read();
            return this.stageDraft(
              proposeOperationEdit(current.text, edit),
              revision,
            );
          }),
        ),
    );
    server.registerTool(
      "ado_workbench_draft_catalog",
      {
        description:
          "Propose a complete validated YAML catalog draft in the panel. Does not save or write Azure. Preserve existing entries; user must inspect and save locally. Never include credentials or secrets.",
        inputSchema: {
          yaml: z.string().max(262144),
          revision: z.string().length(64),
        },
      },
      (args) =>
        toolResult(() =>
          this.run(() => this.stageDraft(args.yaml, args.revision)),
        ),
    );
    return server;
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.pending]);
    await this.disconnect();
    this.changed.dispose();
    this.definitionsChanged.dispose();
  }
}
