import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("Webview did not reach expected state");
}
test("webview escapes remote names, keeps editor changes on refresh and shares execution review", async () => {
  const dom = new JSDOM(
    '<body><span id="connection"></span><nav id="tabs"></nav><div id="notice"></div><main id="content"></main></body>',
    { runScripts: "outside-only", url: "https://webview.example.invalid" },
  );
  const requests: { action: string; data: unknown }[] = [];
  const snapshot = {
    trusted: true,
    active: "example",
    profiles: [{ id: "example", name: "Example profile" }],
    capabilities: { writesEnabled: true, approvalsEnabled: false },
    operations: [
      {
        id: "<img src=x onerror=alert(1)>",
        description: "Example operation",
        modes: ["enabled"],
      },
    ],
    executions: [],
  };
  Object.defineProperty(dom.window, "acquireVsCodeApi", {
    value: () => ({
      postMessage: (message: { id: number; action: string; data: unknown }) => {
        requests.push(message);
        let result: unknown = snapshot;
        if (message.action === "catalog")
          result = {
            text: 'schemaVersion: "1"\ntargets: {}\noperations: {}\n',
            revision: "a".repeat(64),
          };
        if (message.action === "validate") result = { valid: true };
        setTimeout(
          () =>
            dom.window.dispatchEvent(
              new dom.window.MessageEvent("message", {
                data: { id: message.id, result },
              }),
            ),
          0,
        );
      },
    }),
  });
  try {
    dom.window.eval(await readFile("extension/media/app.js", "utf8"));
    await waitFor(
      () => dom.window.document.querySelectorAll(".card").length === 1,
    );
    assert.equal(dom.window.document.querySelector("img"), null);
    assert.ok(
      dom.window.document.querySelector("h3")!.textContent!.includes("<img"),
    );
    const tab = [...dom.window.document.querySelectorAll("nav button")].find(
      (b) => b.textContent === "Catálogo YAML",
    ) as HTMLButtonElement;
    tab.click();
    await waitFor(() => !!dom.window.document.querySelector("textarea"));
    const textarea = dom.window.document.querySelector("textarea")!;
    textarea.value += "# local edit";
    textarea.dispatchEvent(new dom.window.Event("input"));
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", { data: { event: "refresh" } }),
    );
    await new Promise((r) => setTimeout(r, 25));
    assert.match(
      dom.window.document.querySelector("textarea")!.value,
      /# local edit/,
    );
    const validate = [...dom.window.document.querySelectorAll("button")].find(
      (b) => b.textContent === "Validar",
    ) as HTMLButtonElement;
    validate.click();
    await waitFor(() => requests.some((r) => r.action === "validate"));
    assert.equal(
      requests.some(
        (r) => r.action === "save" || r.action === "executionAction",
      ),
      false,
    );
    assert.equal(
      dom.window.document.querySelectorAll("input[type=password]").length,
      0,
    );
  } finally {
    dom.window.close();
  }
});
