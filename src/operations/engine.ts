import {
  validateEnvironmentPolicy,
  findDirectDownstreamDependencies,
} from "./environment-policy.js";
import {
  verifyPostUpdateInvariants,
  expectedVariablesVisible,
  executionEnvironment,
  artifactIdentity,
} from "./post-update.js";
import { attemptOutcome } from "./attempt-state.js";
import {
  normalizeVariables,
  matchesExpectedVariable,
} from "./variable-state.js";
import { artifactMetadataSchema } from "../services/release-metadata.js";
import { matchesBranch } from "./gateway.js";
import { randomUUID } from "node:crypto";
import { AppError, safeError } from "../errors.js";
import {
  digest,
  type Catalog,
  type Operation,
  type Target,
} from "./catalog.js";
import type {
  Environment,
  Release,
  ReleaseGateway,
  Approval,
} from "./gateway.js";
import type { RecordStore } from "./store.js";
type Variable = Release["variables"][string];
export interface Delta {
  name: string;
  scope: "release" | "environment";
  before: Variable | null;
  after: Variable | null;
}
export type State =
  | "planned"
  | "cancelled"
  | "writing"
  | "variablesUpdated"
  | "requestingApproval"
  | "requestingDeployment"
  | "tracking"
  | "awaitingApproval"
  | "succeeded"
  | "failed"
  | "conflict"
  | "uncertain"
  | "interrupted"
  | "trackingTimedOut";
export interface Execution {
  id: string;
  operation: string;
  mode: string;
  target: Target;
  policy: Operation;
  catalogHash: string;
  releaseId: number;
  releaseName: string;
  environmentId: number;
  environmentName: string;
  fingerprint: string;
  expectedAttempt: number;
  changes: Delta[];
  artifacts: unknown[];
  warnings?: {
    code: string;
    message: string;
    stages: { id: number; name: string }[];
  }[];
  state: State;
  createdAt: string;
  expiresAt: string;
  deadline: string;
  events: { at: string; message: string }[];
  error?: ReturnType<typeof safeError>;
  approvals: Approval[];
  rollbackOf?: string;
  deploymentRequestedAt?: string;
  observedAttempt?: number;
  observedDeploymentId?: number;
  observedAttemptId?: number;
  decidedApprovalIds?: number[];
  lastMutation?: "variables" | "deployment" | "approval";
  observabilityError?: ReturnType<typeof safeError>;
}
const terminal = new Set<State>([
  "succeeded",
  "failed",
  "cancelled",
  "conflict",
  "uncertain",
  "interrupted",
  "trackingTimedOut",
]);
const active = new Set<State>([
  "writing",
  "variablesUpdated",
  "requestingDeployment",
  "requestingApproval",
  "tracking",
  "awaitingApproval",
  "uncertain",
  "interrupted",
  "trackingTimedOut",
]);
export class OperationEngine {
  private busy = new Set<string>();
  constructor(
    private gateway: ReleaseGateway,
    private store: RecordStore<Execution>,
    private catalog: () => Promise<{ catalog: Catalog; hash: string }>,
    private allowed: string[],
    private writes: boolean,
    private approvalWrites: boolean,
    private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}
  async listOperations() {
    const { catalog } = await this.catalog();
    return Object.entries(catalog.operations).map(([id, o]) => ({
      id,
      description: o.description,
      modes: o.modes,
      target: o.target,
    }));
  }
  async recover() {
    for (const r of await this.store.list())
      if (
        [
          "writing",
          "variablesUpdated",
          "requestingDeployment",
          "requestingApproval",
        ].includes(r.state)
      ) {
        r.state = "interrupted";
        this.event(
          r,
          "Process interrupted during mutation. Inspect Azure before recovery; no writes replayed.",
        );
        await this.store.put(r);
      }
  }
  private event(r: Execution, message: string) {
    r.events.push({ at: new Date(this.now()).toISOString(), message });
  }
  private guard(
    t: Target,
    r: Release,
    policy: Operation,
    changesGlobal = false,
  ): Environment {
    if (this.allowed.length && !this.allowed.includes(t.organization))
      throw new AppError("FORBIDDEN_SCOPE", "Organization outside allowlist.");
    if (r.releaseDefinition.id !== t.definitionId || r.status !== "active")
      throw new AppError(
        "INVALID_TARGET",
        "Release must be active and belong to the configured definition.",
      );
    const matches = r.environments.filter(
      (e) =>
        e.definitionEnvironmentId === t.environment.definitionEnvironmentId,
    );
    const env = matches[0];
    if (matches.length !== 1 || !env || env.name !== t.environment.expectedName)
      throw new AppError("INVALID_TARGET", "Environment ID/name mismatch.");
    if (t.selection.sourceBranch && !matchesBranch(r, t.selection.sourceBranch))
      throw new AppError(
        "INVALID_TARGET",
        "Artifact branch does not match configured branch.",
      );
    validateEnvironmentPolicy(r, env, policy, changesGlobal);
    return env;
  }
  reviewCapabilities() {
    return {
      writesEnabled: this.writes,
      approvalsEnabled: this.writes && this.approvalWrites,
    };
  }
  private downstreamWarnings(release: Release, env: Environment) {
    const stages = findDirectDownstreamDependencies(release, env).map((e) => ({
      id: e.id,
      name: e.name,
    }));
    return stages.length
      ? [
          {
            code: "DOWNSTREAM_DEPENDENCY",
            message: `${env.name} has downstream stage dependencies. Azure DevOps may trigger subsequent stages according to the release configuration. Tracking covers only the selected stage.`,
            stages,
          },
        ]
      : [];
  }
  private fingerprint(r: Release) {
    // Whole snapshot, including configuration and variables, except server-maintained timestamps/identities/links.
    const clean = { ...r };
    for (const key of ["modifiedOn", "modifiedBy", "_links", "url"])
      delete clean[key];
    // Azure may omit false isSecret flags. Compare that representation equivalently,
    // while preserving every other variable field and all actual secret flags.
    clean.variables = normalizeVariables(r.variables);
    clean.environments = r.environments.map((e) => ({
      ...e,
      variables: normalizeVariables(e.variables),
    }));
    return digest(clean);
  }
  private variables(r: Release, envId: number, scope: Delta["scope"]) {
    return scope === "release"
      ? r.variables
      : r.environments.find((e) => e.id === envId)!.variables;
  }
  private readVariable(
    vars: Release["variables"],
    name: string,
  ): Variable | null {
    const keys = Object.keys(vars).filter(
      (k) => k.toLowerCase() === name.toLowerCase(),
    );
    if (keys.length > 1 || (keys[0] && keys[0] !== name))
      throw new AppError(
        "AMBIGUOUS_VARIABLE",
        "Variable casing must match exactly and be unique.",
      );
    const v = Object.hasOwn(vars, name) ? vars[name]! : null;
    if (v && (v.isSecret === true || typeof v.value !== "string"))
      throw new AppError(
        "UNSUPPORTED_SECRET",
        "Secret variables or variables without a visible string value cannot be changed or restored.",
      );
    return v;
  }
  async plan(operation: string, mode: string) {
    const { catalog, hash } = await this.catalog();
    const op = Object.hasOwn(catalog.operations, operation)
      ? catalog.operations[operation]
      : undefined;
    if (!op || !op.modes.includes(mode))
      throw new AppError("INVALID_OPERATION", "Unknown operation or mode.");
    const reference = catalog.targets[op.target]!;
    if (this.allowed.length && !this.allowed.includes(reference.organization))
      throw new AppError("FORBIDDEN_SCOPE", "Organization outside allowlist.");
    const target = await this.gateway.resolveTarget(reference);
    const release = await this.gateway.select(target),
      env = this.guard(target, release, op);
    const changes = op.variables.map((v) => {
      const before = this.readVariable(
        this.variables(release, env.id, v.scope),
        v.name,
      );
      if (!before && v.mustExist)
        throw new AppError("VARIABLE_MISSING", "Required variable not found.");
      return {
        name: v.name,
        scope: v.scope,
        before,
        after: { ...(before ?? { isSecret: false }), value: v.values[mode]! },
      };
    });
    return this.savePlan(
      operation,
      mode,
      target,
      op,
      hash,
      release,
      env,
      changes,
    );
  }
  private async savePlan(
    operation: string,
    mode: string,
    target: Target,
    policy: Operation,
    hash: string,
    release: Release,
    env: Environment,
    changes: Delta[],
    rollbackOf?: string,
  ) {
    if (
      !policy.deployment.redeployWhenUnchanged &&
      changes.every((d) => matchesExpectedVariable(d.before, d.after))
    )
      throw new AppError(
        "NO_CHANGES",
        "Values already match; no deployment requested.",
      );
    validateEnvironmentPolicy(
      release,
      env,
      policy,
      changes.some(
        (d) =>
          d.scope === "release" && !matchesExpectedVariable(d.before, d.after),
      ),
    );
    const r: Execution = {
      id: randomUUID(),
      operation,
      mode,
      target,
      policy,
      catalogHash: hash,
      releaseId: release.id,
      releaseName: release.name,
      environmentId: env.id,
      environmentName: env.name,
      fingerprint: this.fingerprint(release),
      expectedAttempt:
        Math.max(0, ...env.deploySteps.map((s) => s.attempt)) + 1,
      changes,
      warnings: this.downstreamWarnings(release, env),
      artifacts: release.artifacts.map((a) => artifactMetadataSchema.parse(a)),
      state: "planned",
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(
        this.now() + policy.planTtlMinutes * 60000,
      ).toISOString(),
      deadline: new Date(
        this.now() + policy.trackingTimeoutMinutes * 60000,
      ).toISOString(),
      events: [],
      approvals: [],
      rollbackOf,
    };
    this.event(r, "Plan prepared. No Azure changes made.");
    await this.store.put(r);
    return r;
  }
  async get(id: string) {
    return this.store.get(id);
  }
  async list() {
    return (await this.store.list())
      .map((r) => ({
        id: r.id,
        operation: r.operation,
        releaseName: r.releaseName,
        environmentName: r.environmentName,
        state: r.state,
        createdAt: r.createdAt,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async cancel(id: string) {
    const r = await this.store.get(id);
    if (r.state !== "planned")
      throw new AppError(
        "INVALID_STATE",
        "Only an unapplied plan can be cancelled.",
      );
    const resource = [
      r.target.organization,
      r.target.project,
      r.releaseId,
    ].join("/");
    if (this.busy.has(resource))
      throw new AppError("BUSY", "Operation is executing.");
    this.busy.add(resource);
    try {
      if ((await this.store.get(id)).state !== "planned")
        throw new AppError("INVALID_STATE", "Plan no longer pending.");
      r.state = "cancelled";
      this.event(r, "Plan cancelled; no changes made.");
      await this.store.put(r);
    } finally {
      this.busy.delete(resource);
    }
  }
  // Called only by the authenticated loopback review controller. No MCP apply bypass.
  async applyFromReview(id: string) {
    if (!this.writes)
      throw new AppError(
        "WRITES_DISABLED",
        "Set AZDO_ENABLE_WRITES=true in the server environment to enable reviewed writes.",
      );
    const r = await this.store.get(id);
    if (r.state !== "planned")
      throw new AppError(
        "INVALID_STATE",
        "Plan is not available for execution.",
      );
    const resource = [
      r.target.organization,
      r.target.project,
      r.releaseId,
    ].join("/");
    if (this.busy.has(resource))
      throw new AppError(
        "BUSY",
        "Another action is in progress for this release.",
      );
    this.busy.add(resource);
    let mutation = false;
    try {
      if ((await this.store.get(id)).state !== "planned")
        throw new AppError("INVALID_STATE", "Plan no longer pending.");
      if (
        Date.parse(r.expiresAt) < this.now() ||
        (await this.catalog()).hash !== r.catalogHash
      )
        throw new AppError(
          "STALE_PLAN",
          "Plan expired or catalog changed. Prepare a new plan.",
        );
      if (
        (await this.store.list()).some(
          (x) =>
            x.id !== r.id &&
            x.target.organization === r.target.organization &&
            x.target.project === r.target.project &&
            x.releaseId === r.releaseId &&
            active.has(x.state),
        )
      )
        throw new AppError(
          "BUSY",
          "An unresolved execution owns this release. Inspect or recover it first.",
        );
      const current = await this.gateway.get(r.target, r.releaseId);
      this.guard(
        r.target,
        current,
        r.policy,
        r.changes.some(
          (d) =>
            d.scope === "release" &&
            !matchesExpectedVariable(d.before, d.after),
        ),
      );
      executionEnvironment(current, r);
      if (this.fingerprint(current) !== r.fingerprint)
        throw new AppError(
          "CONFLICT",
          "Release changed since review. Prepare a new plan.",
        );
      const before = structuredClone(current);
      for (const d of r.changes) {
        const vars = this.variables(current, r.environmentId, d.scope);
        if (d.after === null) delete vars[d.name];
        else vars[d.name] = structuredClone(d.after);
      }
      const valuesChanged = r.changes.some(
        (d) => !matchesExpectedVariable(d.before, d.after),
      );
      if (valuesChanged) {
        r.state = "writing";
        r.lastMutation = "variables";
        this.event(r, "Local review accepted; saving variables.");
        await this.store.put(r);
        mutation = true;
        await this.gateway.update(r.target, current);
        this.event(r, "Variable update request accepted.");
        await this.store.put(r);
      } else {
        this.event(
          r,
          "Values unchanged; local review accepted for redeploy only. No variable update required.",
        );
      }
      if (valuesChanged) await this.verifyReadAfterWrite(before, r);
      // No PUT: the strict pre-write snapshot is already the current checked state.
      else verifyPostUpdateInvariants(before, current, r);
      r.state = "variablesUpdated";
      this.event(
        r,
        valuesChanged
          ? "Variables saved and verified."
          : "Unchanged variables verified before redeploy.",
      );
      await this.store.put(r);
      this.event(r, "Post-update validation passed.");
      r.state = "requestingDeployment";
      r.lastMutation = "deployment";
      r.deploymentRequestedAt = new Date(this.now()).toISOString();
      r.deadline = new Date(
        this.now() + r.policy.trackingTimeoutMinutes * 60000,
      ).toISOString();
      this.event(r, "Requesting environment redeploy.");
      await this.store.put(r);
      mutation = true;
      await this.gateway.deploy(
        r.target,
        r.releaseId,
        r.environmentId,
        `MCP operation ${r.id}`,
      );
      r.state = "tracking";
      this.event(
        r,
        "Deployment request accepted; waiting for this deployment attempt.",
      );
      await this.store.put(r);
    } catch (e) {
      r.state = mutation ? "uncertain" : "conflict";
      r.error = safeError(e);
      if (
        e instanceof AppError &&
        ["VERIFY_FAILED", "UNSUPPORTED_SECRET"].includes(e.code)
      )
        this.event(
          r,
          "Variable update could not be verified; redeploy was not requested.",
        );
      this.event(
        r,
        mutation
          ? "Execution stopped. Inspect Azure; no automatic replay or rollback."
          : "Plan cannot be applied.",
      );
      await this.store.put(r);
    } finally {
      this.busy.delete(resource);
    }
    return r;
  }
  private async verifyReadAfterWrite(before: Release, r: Execution) {
    const deadline = performance.now() + 5000;
    for (
      let attempt = 0;
      attempt < 5 && performance.now() < deadline;
      attempt++
    ) {
      try {
        const saved = await this.gateway.get(r.target, r.releaseId, {
          timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())),
          maxRetries: 0,
        });
        verifyPostUpdateInvariants(before, saved, r, false);
        if (expectedVariablesVisible(saved, r)) return;
        const env = executionEnvironment(saved, r);
        if (
          r.changes.some(
            (d) =>
              (d.scope === "release" ? saved.variables : env.variables)[d.name]
                ?.isSecret === true,
          )
        )
          throw new AppError(
            "UNSUPPORTED_SECRET",
            "A reviewed variable is now secret; redeploy was not requested.",
          );
      } catch (e) {
        if (
          !(e instanceof AppError) ||
          !(
            e.code === "TRANSPORT_ERROR" ||
            e.status === 429 ||
            (e.status !== undefined && e.status >= 500)
          )
        )
          throw e;
      }
      if (attempt < 4 && performance.now() < deadline)
        await this.sleep(Math.min(750, deadline - performance.now()));
    }
    throw new AppError(
      "VERIFY_FAILED",
      "Requested values or variable absence were not visible within bounded verification; redeploy was not requested.",
    );
  }
  async refresh(id: string) {
    const r = await this.store.get(id);
    if (!["tracking", "awaitingApproval"].includes(r.state)) return r;
    const resource = [
      r.target.organization,
      r.target.project,
      r.releaseId,
    ].join("/");
    if (this.busy.has(resource)) return r;
    this.busy.add(resource);
    try {
      const release = await this.gateway.get(r.target, r.releaseId);
      const env = executionEnvironment(release, r);
      if (
        digest(artifactIdentity(release.artifacts)) !==
        digest(artifactIdentity(r.artifacts))
      )
        throw new AppError(
          "POST_UPDATE_ARTIFACT_CHANGED",
          "Artifact identity changed during tracking; inspect Azure.",
        );
      const latest = Math.max(0, ...env.deploySteps.map((s) => s.attempt));
      const attempts = env.deploySteps.filter(
        (s) => s.attempt === r.expectedAttempt,
      );
      const attempt = attempts[0];
      if (
        latest > r.expectedAttempt ||
        attempts.length > 1 ||
        (attempt?.deploymentId !== undefined &&
          r.observedDeploymentId !== undefined &&
          attempt.deploymentId !== r.observedDeploymentId) ||
        (attempt?.id !== undefined &&
          r.observedAttemptId !== undefined &&
          attempt.id !== r.observedAttemptId)
      ) {
        r.state = "uncertain";
        r.error = safeError(
          new AppError(
            "STALE_ATTEMPT",
            "Deployment attempt changed or is ambiguous; inspect Azure.",
          ),
        );
        this.event(
          r,
          "A newer or ambiguous deployment attempt exists. Inspect Azure.",
        );
      } else {
        try {
          r.approvals = await this.gateway.approvals(
            r.target,
            r.releaseId,
            r.environmentId,
            r.expectedAttempt,
          );
          r.approvals = r.approvals.filter(
            (a) => !r.decidedApprovalIds?.includes(a.id),
          );
          delete r.observabilityError;
        } catch (e) {
          r.approvals = [];
          r.observabilityError = safeError(e);
          if (
            !r.events.some(
              (e) =>
                e.message ===
                "Approval visibility unavailable; continuing deployment tracking.",
            )
          )
            this.event(
              r,
              "Approval visibility unavailable; continuing deployment tracking.",
            );
        }
        let next: State = r.approvals.length ? "awaitingApproval" : "tracking";
        if (attempt) {
          if (r.observedAttempt === undefined)
            this.event(r, `Deployment attempt detected: ${attempt.attempt}.`);
          r.observedAttempt = attempt.attempt;
          if (attempt.deploymentId !== undefined)
            r.observedDeploymentId = attempt.deploymentId;
          if (attempt.id !== undefined) r.observedAttemptId = attempt.id;
          const outcome = attemptOutcome(attempt);
          if (outcome !== "tracking") next = outcome;
          if (!expectedVariablesVisible(release, r)) {
            next = "uncertain";
            r.error = safeError(
              new AppError(
                "CONFLICT",
                "Variables changed during deployment; inspect the resulting configuration.",
              ),
            );
          }
        }
        if (Date.parse(r.deadline) < this.now() && !terminal.has(next)) {
          next = "trackingTimedOut";
          r.error = safeError(
            new AppError(
              r.observedAttempt === undefined
                ? "DEPLOYMENT_NOT_OBSERVED"
                : "TRACKING_TIMEOUT",
              "Deployment observation timed out. Reconcile in Azure before another mutation.",
            ),
          );
        } else if (next !== "uncertain") delete r.error;
        if (next !== r.state) {
          r.state = next;
          this.event(r, `Deployment state: ${next}`);
        }
      }
      await this.store.put(r);
    } catch (e) {
      r.error = safeError(e);
      if (
        e instanceof AppError &&
        ["POST_UPDATE_TARGET_CHANGED", "POST_UPDATE_ARTIFACT_CHANGED"].includes(
          e.code,
        )
      )
        r.state = "uncertain";
      else if (Date.parse(r.deadline) < this.now()) {
        r.state = "trackingTimedOut";
        r.error = safeError(
          new AppError(
            r.observedAttempt === undefined
              ? "DEPLOYMENT_NOT_OBSERVED"
              : "TRACKING_TIMEOUT",
            "Tracking timed out while Azure could not be queried.",
          ),
        );
        this.event(r, "Tracking timed out while Azure could not be queried.");
      }
      await this.store.put(r);
    } finally {
      this.busy.delete(resource);
    }
    return r;
  }
  async refreshAll() {
    for (const r of await this.store.list())
      if (["tracking", "awaitingApproval"].includes(r.state))
        await this.refresh(r.id);
  }
  async decideFromReview(
    id: string,
    approvalId: number,
    decision: "approved" | "rejected",
    comment: string,
  ) {
    if (!this.writes || !this.approvalWrites)
      throw new AppError(
        "APPROVALS_DISABLED",
        "Enable reviewed approval decisions explicitly in server configuration.",
      );
    const r = await this.refresh(id);
    if (r.state === "uncertain" && r.error?.code === "CONFLICT")
      throw new AppError(
        "CONFLICT",
        "Variables changed before approval. Inspect Azure.",
      );
    if (
      r.policy.approvals !== "explicit" ||
      r.state !== "awaitingApproval" ||
      !comment.trim() ||
      comment.length > 1000
    )
      throw new AppError(
        "INVALID_APPROVAL",
        "Explicit approval mode and a comment are required.",
      );
    const resource = [
      r.target.organization,
      r.target.project,
      r.releaseId,
    ].join("/");
    if (this.busy.has(resource))
      throw new AppError("BUSY", "Another action is in progress.");
    this.busy.add(resource);
    try {
      const persisted = await this.store.get(id);
      if (
        persisted.state !== "awaitingApproval" ||
        persisted.decidedApprovalIds?.includes(approvalId)
      )
        throw new AppError(
          "STALE_APPROVAL",
          "Approval is no longer pending for this attempt.",
        );
      const release = await this.gateway.get(r.target, r.releaseId);
      const env = executionEnvironment(release, r);
      if (
        !env ||
        Math.max(0, ...env.deploySteps.map((s) => s.attempt)) >
          r.expectedAttempt
      )
        throw new AppError("STALE_APPROVAL", "A newer attempt exists.");
      if (
        decision === "approved" &&
        r.changes.some(
          (d) =>
            !matchesExpectedVariable(
              this.variables(release, r.environmentId, d.scope)[d.name],
              d.after,
            ),
        )
      )
        throw new AppError(
          "CONFLICT",
          "Variables changed before approval. Inspect Azure.",
        );
      const approvals = await this.gateway.approvals(
        r.target,
        r.releaseId,
        r.environmentId,
        r.expectedAttempt,
      );
      if (!approvals.some((a) => a.id === approvalId))
        throw new AppError(
          "STALE_APPROVAL",
          "Approval is no longer pending for this attempt.",
        );
      try {
        r.lastMutation = "approval";
        r.state = "requestingApproval";
        this.event(r, "Requesting reviewed approval decision.");
        await this.store.put(r);
        await this.gateway.decide(r.target, approvalId, decision, comment);
        r.state = "tracking";
        r.decidedApprovalIds = [...(r.decidedApprovalIds ?? []), approvalId];
        this.event(r, `Approval ${approvalId}: ${decision}.`);
        r.approvals = r.approvals.filter((a) => a.id !== approvalId);
      } catch (e) {
        r.state = "uncertain";
        r.error = safeError(e);
        this.event(
          r,
          "Approval result is uncertain. Inspect Azure before another decision.",
        );
      }
      await this.store.put(r);
      return r;
    } finally {
      this.busy.delete(resource);
    }
  }

  async planRollback(id: string) {
    const previous = await this.store.get(id);
    if (!["succeeded", "failed"].includes(previous.state))
      throw new AppError(
        "INVALID_STATE",
        "Wait for execution completion before preparing restoration.",
      );
    const { hash } = await this.catalog();
    if (hash !== previous.catalogHash)
      throw new AppError(
        "CATALOG_CHANGED",
        "Restore with the original reviewed catalog version.",
      );
    const release = await this.gateway.get(previous.target, previous.releaseId),
      env = this.guard(previous.target, release, previous.policy);
    executionEnvironment(release, previous);
    if (
      digest(artifactIdentity(release.artifacts)) !==
      digest(artifactIdentity(previous.artifacts))
    )
      throw new AppError(
        "ROLLBACK_CONFLICT",
        "Artifact identity changed since the operation. Restoration cannot reuse that deployment target.",
      );
    const changes = previous.changes.map((d) => {
      const current = this.readVariable(
        this.variables(release, env.id, d.scope),
        d.name,
      );
      if (!matchesExpectedVariable(current, d.after))
        throw new AppError(
          "ROLLBACK_CONFLICT",
          "A changed variable no longer matches the value written by this operation.",
        );
      return { ...d, before: current, after: d.before };
    });
    // Recovery acknowledges ambiguous writes only after operator reviewed Azure in the local UI.
    return this.savePlan(
      previous.operation,
      "restore",
      previous.target,
      previous.policy,
      hash,
      release,
      env,
      changes,
      id,
    );
  }
  async acknowledgeRecovery(id: string) {
    const r = await this.store.get(id);
    if (!["uncertain", "interrupted", "trackingTimedOut"].includes(r.state))
      throw new AppError("INVALID_STATE", "No recovery acknowledgment needed.");
    const resource = [
      r.target.organization,
      r.target.project,
      r.releaseId,
    ].join("/");
    if (this.busy.has(resource))
      throw new AppError("BUSY", "Another action is in progress.");
    this.busy.add(resource);
    try {
      if (
        !["uncertain", "interrupted", "trackingTimedOut"].includes(
          (await this.store.get(id)).state,
        )
      )
        throw new AppError("INVALID_STATE", "Recovery already acknowledged.");
      // This is an operator attestation, not a claim that a GET can prove reconciliation.
      r.state = "failed";
      this.event(
        r,
        "Operator acknowledged reconciliation in Azure. No Azure mutation or cancellation performed.",
      );
      await this.store.put(r);
    } finally {
      this.busy.delete(resource);
    }
  }
}
