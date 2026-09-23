import { z } from "zod";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "../../src/errors.js";
import { organizationSchema, projectSchema } from "../../src/config.js";
import { digest, parseCatalog } from "../../src/operations/catalog.js";
import type { Execution } from "../../src/operations/engine.js";
import type { RecordStore } from "../../src/operations/store.js";
export const profileSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    organization: organizationSchema,
    project: projectSchema,
    auth: z.enum(["pat", "bearer"]).default("pat"),
    revision: z.number().int().nonnegative(),
    caFile: z.string().optional(),
    proxy: z
      .string()
      .url()
      .refine((value) => {
        const u = new URL(value);
        return (
          ["http:", "https:"].includes(u.protocol) && !u.username && !u.password
        );
      })
      .optional(),
  })
  .strict();
export type Profile = z.infer<typeof profileSchema>;
export const unresolved = new Set([
  "writing",
  "variablesUpdated",
  "requestingDeployment",
  "requestingApproval",
  "tracking",
  "awaitingApproval",
  "uncertain",
  "interrupted",
  "trackingTimedOut",
]);
export type BoundExecution = Execution & { connectionId?: string };
/** One shared encrypted store/lock; views isolate profiles without bypassing unresolved releases. */
export class ConnectionStore implements RecordStore<Execution> {
  constructor(
    private base: RecordStore<BoundExecution>,
    private connectionId: string,
  ) {}
  async put(r: Execution) {
    await this.base.put({ ...r, connectionId: this.connectionId });
  }
  async get(id: string) {
    const r = await this.base.get(id);
    if (r.connectionId !== this.connectionId)
      throw new AppError(
        "PROFILE_MISMATCH",
        "Select the connection that owns this execution.",
      );
    return r;
  }
  async list() {
    return (await this.base.list()).filter(
      (r) => r.connectionId === this.connectionId,
    );
  }
  async ensureAvailable() {
    if (
      (await this.base.list()).some(
        (r) => r.connectionId !== this.connectionId && unresolved.has(r.state),
      )
    )
      throw new AppError(
        "PROFILE_BUSY",
        "Another connection has unresolved executions. Select it and reconcile before switching.",
      );
  }
}
export const emptyCatalog = 'schemaVersion: "1"\ntargets: {}\noperations: {}\n';
export class CatalogRepository {
  private saving = false;
  constructor(readonly path: string) {}
  async initialize() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(this.path, emptyCatalog, { flag: "wx", mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  async read() {
    const text = await readFile(this.path, "utf8");
    return { text, revision: digest(text), ...parseCatalog(text) };
  }
  async save(text: string, expectedRevision: string) {
    if (this.saving)
      throw new AppError(
        "CATALOG_BUSY",
        "Another catalog save is in progress.",
      );
    this.saving = true;
    try {
      parseCatalog(text);
      if ((await this.read()).revision !== expectedRevision)
        throw new AppError(
          "CATALOG_CONFLICT",
          "Catalog changed. Reload it and review the differences before saving.",
        );
      const tmp = this.path + "." + randomUUID() + ".tmp";
      await writeFile(tmp, text, { flag: "wx", mode: 0o600 });
      await rename(tmp, this.path);
    } finally {
      this.saving = false;
    }
  }
}
