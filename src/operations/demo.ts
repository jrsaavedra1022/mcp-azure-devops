import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadCatalog } from "./catalog.js";
import { DemoGateway } from "./demo-gateway.js";
import { EncryptedStore } from "./store.js";
import { OperationEngine, type Execution } from "./engine.js";
import { startReviewServer } from "./review-server.js";
const directory = await mkdtemp(join(tmpdir(), "azdo-demo-"));
const store = new EncryptedStore<Execution>(directory);
await store.open();
const catalog = () => loadCatalog(resolve("examples/operations.yaml"));
const engine = new OperationEngine(
  new DemoGateway(),
  store,
  catalog,
  [],
  true,
  false,
);
const plan = await engine.plan("integration-mode", "simulated");
const review = await startReviewServer(engine, { demo: true });
console.log("DEMO · Synthetic data only; no Azure requests.");
console.log(review.url(plan.id));
let refreshing = false;
const timer = setInterval(() => {
  if (!refreshing) {
    refreshing = true;
    void engine.refreshAll().finally(() => {
      refreshing = false;
    });
  }
}, 1000);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    clearInterval(timer);
    void review
      .close()
      .then(() => store.close())
      .finally(() => process.exit(0));
  });
