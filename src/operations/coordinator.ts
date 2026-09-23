import { OperationEngine, type Execution } from "./engine.js";
import type { ReleaseGateway } from "./gateway.js";
import type { RecordStore } from "./store.js";
import type { Catalog } from "./catalog.js";
export interface ReviewSurface {
  url(id?: string): string;
  close(): Promise<void>;
}
export interface CoordinatorOptions {
  gateway: ReleaseGateway;
  store: RecordStore<Execution>;
  catalog: () => Promise<{ catalog: Catalog; hash: string }>;
  allowed: string[];
  writes: boolean;
  approvalWrites: boolean;
  review: (engine: OperationEngine) => Promise<ReviewSurface>;
  onRefresh?: () => void;
}
/** Environment-independent lifecycle shared by CLI and the VS Code extension. */
export async function createCoordinator(options: CoordinatorOptions) {
  const engine = new OperationEngine(
    options.gateway,
    options.store,
    options.catalog,
    options.allowed,
    options.writes,
    options.approvalWrites,
  );
  await engine.recover();
  const review = await options.review(engine);
  let pending: Promise<void> | undefined,
    closing = false;
  const timer = setInterval(() => {
    if (pending || closing) return;
    pending = engine
      .refreshAll()
      .then(() => options.onRefresh?.())
      .catch(() => {})
      .finally(() => {
        pending = undefined;
      });
  }, 5000);
  timer.unref();
  return {
    engine,
    review,
    async close() {
      closing = true;
      clearInterval(timer);
      await pending;
      await review.close();
    },
  };
}
export type Coordinator = Awaited<ReturnType<typeof createCoordinator>>;
