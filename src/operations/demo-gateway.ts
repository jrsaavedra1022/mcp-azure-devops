import { AppError } from "../errors.js";
import { resolveEnvironmentTarget } from "./target-resolver.js";
import type { ReleaseGateway, Release, Approval } from "./gateway.js";
import type { CatalogTarget, Target } from "./catalog.js";
export const demoRelease: Release = {
  id: 987,
  name: "Release-42",
  status: "active",
  releaseDefinition: { id: 123 },
  variables: { "integration-enabled": { value: "false", isSecret: false } },
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
      deploySteps: [{ attempt: 1, status: "succeeded" }],
    },
  ],
};
export class DemoGateway implements ReleaseGateway {
  release = structuredClone(demoRelease);
  writes = 0;
  deploys = 0;
  async resolveTarget(t: CatalogTarget): Promise<Target> {
    if ("definitionId" in t && "definitionEnvironmentId" in t.environment)
      return {
        ...t,
        environment: { ...t.environment },
        selection: { ...t.selection },
      };
    if ("definition" in t && t.definition.name !== "Example Application")
      throw new AppError(
        "RELEASE_DEFINITION_NOT_FOUND",
        "Demo definition was not found.",
      );
    return resolveEnvironmentTarget(t, {
      id: "definitionId" in t ? t.definitionId : 123,
      name: "Example Application",
      environments: demoRelease.environments.map((e) => ({
        id: e.definitionEnvironmentId,
        name: e.name,
      })),
    });
  }
  async select() {
    return structuredClone(this.release);
  }
  async get() {
    return structuredClone(this.release);
  }
  async update(_t: Target, r: Release) {
    this.writes++;
    this.release = structuredClone(r);
  }
  async deploy() {
    this.deploys++;
    const e = this.release.environments[0]!;
    e.deploySteps.push({
      attempt: e.deploySteps.length + 1,
      status: "succeeded",
    });
    e.status = "succeeded";
  }
  async approvals(): Promise<Approval[]> {
    return [];
  }
  async decide() {}
}
