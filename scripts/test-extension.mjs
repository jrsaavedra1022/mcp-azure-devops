import { runTests } from "@vscode/test-electron";
import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
const profile = await mkdtemp(resolve(tmpdir(), "classic-vscode-test-"));
try {
  await runTests({
    version: "1.105.1",
    extensionDevelopmentPath: resolve("extension"),
    extensionTestsPath: resolve("extension/test/smoke.cjs"),
    launchArgs: [
      "--user-data-dir",
      profile,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-extensions",
    ],
  });
} finally {
  await rm(profile, { recursive: true, force: true });
}
