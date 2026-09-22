import { resolve } from "node:path";
import { loadCatalog } from "./catalog.js";
try {
  const { catalog } = await loadCatalog(
    resolve(process.argv[2] ?? "examples/operations.yaml"),
  );
  console.log(
    `Valid catalog: ${Object.keys(catalog.operations).length} operations, ${Object.keys(catalog.targets).length} targets.`,
  );
} catch {
  console.error(
    "Invalid catalog. Check docs/OPERATIONS.md and examples/operations.yaml.",
  );
  process.exitCode = 1;
}
