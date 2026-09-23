import { readFile, readdir, writeFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { EncryptedStore } from "../../src/operations/store.js";
import { AppError } from "../../src/errors.js";
import { digest } from "../../src/operations/catalog.js";
import type { BoundExecution } from "./model.js";
/** Resumable, fail-closed import. Source records/key are untouched; both stores are locked. */
export async function importLegacyState(
  source: string,
  destination: string,
  connectionId: string,
) {
  z.string().uuid().parse(connectionId);
  if (resolve(source) === resolve(destination))
    throw new AppError(
      "INVALID_STATE_SOURCE",
      "Select the legacy CLI state directory, not the extension state.",
    );
  try {
    if ((await readFile(join(source, "key"))).length !== 32) throw Error();
  } catch {
    throw new AppError(
      "INVALID_STATE_SOURCE",
      "Selected directory does not contain a valid state key.",
    );
  }
  const destinationStore = new EncryptedStore<BoundExecution>(destination, {
    allowIncompleteMigration: true,
  });
  await destinationStore.open();
  const legacy = new EncryptedStore<BoundExecution>(source);
  let legacyOpen = false;
  try {
    await legacy.open();
    legacyOpen = true;
    const records = await legacy.list();
    for (const r of records)
      z.object({
        id: z.string().uuid(),
        state: z.string(),
        target: z.object({ organization: z.string(), project: z.string() }),
        changes: z.array(z.unknown()),
        events: z.array(z.unknown()),
        releaseId: z.number(),
      }).parse(r);
    const manifest = {
      connectionId,
      fingerprint: digest(records.sort((a, b) => a.id.localeCompare(b.id))),
    };
    const path = join(destination, "migration.pending");
    let resume = false;
    try {
      const prior = JSON.parse(await readFile(path, "utf8"));
      if (digest(prior) !== digest(manifest))
        throw new AppError(
          "MIGRATION_CONFLICT",
          "Resume using the same source and connection. Original records must be unchanged.",
        );
      resume = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const existing = (await readdir(destination)).filter((n) =>
      n.endsWith(".enc"),
    );
    if (
      (!resume && existing.length) ||
      existing.some((n) => !records.some((r) => n === r.id + ".enc"))
    )
      throw new AppError(
        "STATE_NOT_EMPTY",
        "Import requires an empty destination or the matching interrupted import. Histories are never merged.",
      );
    if (!resume)
      await writeFile(path, JSON.stringify(manifest), {
        flag: "wx",
        mode: 0o600,
      });
    for (const r of records) await destinationStore.put({ ...r, connectionId });
    await unlink(path);
    return records.length;
  } finally {
    if (legacyOpen) await legacy.close();
    await destinationStore.close();
  }
}
