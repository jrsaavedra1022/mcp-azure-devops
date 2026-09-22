import type { ReleaseGateway, Release, Approval } from "./gateway.js";
import type { Target } from "./catalog.js";
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
