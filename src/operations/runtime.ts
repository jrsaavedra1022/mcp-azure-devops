import { homedir } from "node:os";
import { resolve, join } from "node:path";
import type { Config } from "../config.js";
import { createLogger } from "../logging.js";
import { RestClient } from "../client/rest-client.js";
import { loadCatalog } from "./catalog.js";
import { AzureReleaseGateway } from "./gateway.js";
import { EncryptedStore } from "./store.js";
import { OperationEngine, type Execution } from "./engine.js";
import { startReviewServer } from "./review-server.js";
export async function startOperations(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!env.AZDO_OPERATIONS_FILE) return undefined;
  const catalogPath = resolve(env.AZDO_OPERATIONS_FILE);
  const catalog = () => loadCatalog(catalogPath);
  await catalog();
  const store = new EncryptedStore<Execution>(
    resolve(
      env.AZDO_STATE_DIR ??
        join(homedir(), ".azure-devops-classic-mcp", "state"),
    ),
  );
  await store.open();
  try {
    const engine = new OperationEngine(
      new AzureReleaseGateway(
        new RestClient(config, createLogger(config.logLevel)),
      ),
      store,
      catalog,
      config.allowedOrganizations,
      env.AZDO_ENABLE_WRITES === "true",
      env.AZDO_ENABLE_APPROVALS === "true",
    );
    await engine.recover();
    const review = await startReviewServer(engine);
    let refreshing = false;
    let current: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (!refreshing) {
        refreshing = true;
        current = engine
          .refreshAll()
          .catch(() => {})
          .finally(() => {
            refreshing = false;
          });
      }
    }, 5000);
    timer.unref();
    return {
      engine,
      review,
      close: async () => {
        clearInterval(timer);
        await current;
        await review.close();
        await store.close();
      },
    };
  } catch (e) {
    await store.close();
    throw e;
  }
}
export type OperationsRuntime = NonNullable<
  Awaited<ReturnType<typeof startOperations>>
>;
