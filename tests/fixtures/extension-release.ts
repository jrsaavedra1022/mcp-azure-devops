import type { Release } from "../../src/operations/gateway.js";
export function fixtureRelease(): Release {
  return {
    id: 987,
    name: "Release-42",
    status: "active",
    releaseDefinition: { id: 123 },
    variables: { "integration-enabled": { value: "false" } },
    artifacts: [],
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
}
