import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CatalogRepository,
  ConnectionStore,
  profileSchema,
  type BoundExecution,
} from "../extension/src/model.js";
import { parseCatalog } from "../src/operations/catalog.js";
import type { RecordStore } from "../src/operations/store.js";
import { demoRelease } from "../src/operations/demo-gateway.js";
import { createNetwork } from "../extension/src/network.js";
test("catalog saves preserve text/comments, reject stale drafts and validate before replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "catalog-extension-"));
  try {
    const repo = new CatalogRepository(join(dir, "catalog.yaml"));
    await repo.initialize();
    const initial = await repo.read();
    const edited = "# operator comment\n" + initial.text;
    await repo.save(edited, initial.revision);
    assert.equal((await repo.read()).text, edited);
    await assert.rejects(repo.save(initial.text, initial.revision), {
      code: "CATALOG_CONFLICT",
    });
    const revision = (await repo.read()).revision;
    await assert.rejects(repo.save("bad: TOKEN_SENTINEL", revision), {
      code: "INVALID_CATALOG",
    });
    assert.equal(await readFile(repo.path, "utf8"), edited);
    const settled = await Promise.allSettled([
      repo.save(edited + "\n", revision),
      repo.save(edited + "\n# concurrent", revision),
    ]);
    assert.equal(settled.filter((r) => r.status === "fulfilled").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("catalog rejects embedded credentials, aliases, duplicate keys and oversized input", () => {
  for (const text of [
    'schemaVersion: "1"\ntargets: {}\noperations: {}\nAZDO_PAT: TOKEN_SENTINEL',
    'schemaVersion: "1"\ntargets: &x {}\noperations: *x',
    'schemaVersion: "1"\nschemaVersion: "1"',
    " ".repeat(262145),
  ])
    assert.throws(() => parseCatalog(text), { code: "INVALID_CATALOG" });
});
class Store implements RecordStore<BoundExecution> {
  rows = new Map<string, BoundExecution>();
  async put(r: BoundExecution) {
    this.rows.set(r.id, structuredClone(r));
  }
  async get(id: string) {
    return structuredClone(this.rows.get(id)!);
  }
  async list() {
    return structuredClone([...this.rows.values()]);
  }
}
test("connection views isolate execution state and block unresolved ownership across profiles", async () => {
  const base = new Store(),
    a = new ConnectionStore(base, "a"),
    b = new ConnectionStore(base, "b");
  const record = {
    id: randomUUID(),
    state: "uncertain",
    releaseId: demoRelease.id,
  } as BoundExecution;
  await a.put(record);
  assert.equal((await a.list()).length, 1);
  assert.deepEqual(await b.list(), []);
  await assert.rejects(b.get(record.id), { code: "PROFILE_MISMATCH" });
  await assert.rejects(b.ensureAvailable(), { code: "PROFILE_BUSY" });
  await a.put({ ...record, state: "failed" });
  await b.ensureAvailable();
  assert.equal((await base.get(record.id)).connectionId, "a");
});
test("profiles reject arbitrary fields and proxy credentials; invalid CA is safely reported", async () => {
  const p = {
    id: randomUUID(),
    name: "Example",
    organization: "example-org",
    project: "Example Project",
    auth: "pat",
    revision: 0,
  };
  assert.equal(
    profileSchema.safeParse({ ...p, token: "TOKEN_SENTINEL" }).success,
    false,
  );
  assert.equal(
    profileSchema.safeParse({
      ...p,
      proxy: "http://user:secret@example.invalid",
    }).success,
    false,
  );
  assert.equal(
    profileSchema.safeParse({ ...p, proxy: "file:///tmp/proxy" }).success,
    false,
  );
  const dir = await mkdtemp(join(tmpdir(), "ca-extension-"));
  try {
    const path = join(dir, "ca.pem");
    await writeFile(path, "TOKEN_SENTINEL");
    await assert.rejects(
      createNetwork(profileSchema.parse({ ...p, caFile: path })),
      (e: unknown) =>
        e instanceof Error && !e.message.includes("TOKEN_SENTINEL"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("history import preserves source and binds records; refuses an existing destination", async () => {
  const { EncryptedStore } = await import("../src/operations/store.js");
  const { importLegacyState } = await import("../extension/src/migration.js");
  const dir = await mkdtemp(join(tmpdir(), "migration-extension-")),
    source = join(dir, "source"),
    destination = join(dir, "destination"),
    owner = randomUUID();
  const legacy = new EncryptedStore<BoundExecution>(source);
  try {
    await legacy.open();
    const row = {
      id: randomUUID(),
      state: "uncertain",
      target: { organization: "example-org", project: "Example Project" },
      changes: [],
      events: [],
      releaseId: 987,
    } as unknown as BoundExecution;
    await legacy.put(row);
    await legacy.close();
    const before = await readFile(join(source, row.id + ".enc"));
    assert.equal(await importLegacyState(source, destination, owner), 1);
    assert.deepEqual(await readFile(join(source, row.id + ".enc")), before);
    const imported = new EncryptedStore<BoundExecution>(destination);
    await imported.open();
    assert.equal((await imported.get(row.id)).connectionId, owner);
    await imported.close();
    await assert.rejects(importLegacyState(source, destination, owner), {
      code: "STATE_NOT_EMPTY",
    });
  } finally {
    await legacy.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("incomplete migration fails closed until explicitly resumed", async () => {
  const { EncryptedStore } = await import("../src/operations/store.js");
  const dir = await mkdtemp(join(tmpdir(), "migration-pending-"));
  try {
    await writeFile(join(dir, "migration.pending"), "{}");
    const store = new EncryptedStore(dir);
    await assert.rejects(store.open(), { code: "STATE_MIGRATION_INCOMPLETE" });
    const resume = new EncryptedStore(dir, { allowIncompleteMigration: true });
    await resume.open();
    await resume.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("targeted Copilot catalog drafts preserve existing mode values and comments", async () => {
  const { proposeOperationEdit } =
    await import("../extension/src/catalog-edits.js");
  const original = await readFile("examples/operations.ids.yaml", "utf8");
  const proposed = proposeOperationEdit("# team comment\n" + original, {
    operation: "integration-mode",
    variables: [
      {
        name: "integration-enabled",
        scope: "release",
        values: { simulated: "custom" },
      },
    ],
  });
  assert.match(proposed, /# team comment/);
  const old = parseCatalog(original).catalog,
    newCatalog = parseCatalog(proposed).catalog;
  assert.equal(
    newCatalog.operations["integration-mode"]!.variables[0]!.values.simulated,
    "custom",
  );
  assert.equal(
    newCatalog.operations["integration-mode"]!.variables[0]!.values.live,
    old.operations["integration-mode"]!.variables[0]!.values.live,
  );
  assert.deepEqual(
    newCatalog.operations["integration-mode"]!.variables[1],
    old.operations["integration-mode"]!.variables[1],
  );
  assert.throws(
    () =>
      proposeOperationEdit(original, {
        operation: "integration-mode",
        variables: [
          { name: "missing", scope: "release", values: { simulated: "x" } },
        ],
      }),
    { code: "VARIABLE_MISSING" },
  );
});
