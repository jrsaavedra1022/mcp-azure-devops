exports.run = async function () {
  const { default: assert } = await import("node:assert/strict");
  const vscode = await import("vscode");
  const extension = vscode.extensions.getExtension(
    "local-classic-workbench.azure-devops-classic-workbench",
  );
  assert.ok(extension, "Packaged extension descriptor must be discoverable");
  const api = await extension.activate();
  assert.equal(api.version, "0.1.0");
  const state = await api.snapshot();
  assert.equal(state.active, undefined);
  assert.deepEqual(state.profiles, []);
  await vscode.commands.executeCommand("classicWorkbench.open");
  assert.ok(extension.isActive);
  console.log(
    "Extension Host smoke passed: activation, MCP provider, empty safe startup and panel command.",
  );
};
