import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppError, startupCode } from "../src/errors.js";
import { EncryptedStore } from "../src/operations/store.js";
import { createLogger } from "../src/logging.js";
for (const code of [
  "STORE_LOCKED",
  "INVALID_CATALOG",
  "INVALID_CONFIGURATION",
  "REVIEW_SERVER_FAILED",
  "STATE_UNAVAILABLE",
] as const)
  test(`startup diagnostics allow only safe ${code}`, () => {
    assert.equal(startupCode(new AppError(code, "TOKEN_SENTINEL")), code);
  });
test("startup logger cannot serialize arbitrary error codes or credentials", () => {
  const lines: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    lines.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    createLogger("error")(
      "startup_failed",
      undefined,
      startupCode(new Error("TOKEN_SENTINEL")),
    );
    createLogger("error")(
      "startup_failed",
      undefined,
      startupCode(new AppError("TOKEN_SENTINEL", "TOKEN_SENTINEL")),
    );
  } finally {
    process.stderr.write = original;
  }
  assert.ok(!lines.join("").includes("TOKEN_SENTINEL"));
  assert.equal(JSON.parse(lines[0]!).code, "STARTUP_FAILED");
});
for (const kind of ["configuration", "catalog", "lock"] as const)
  test(`real stdio startup emits safe code for ${kind}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-startup-"));
    const store = new EncryptedStore<{ id: string }>(dir);
    try {
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(env))
        if (key.startsWith("AZDO_")) delete env[key];
      env.AZDO_STATE_DIR = dir;
      if (kind !== "configuration") env.AZDO_PAT = "TOKEN_SENTINEL";
      if (kind === "catalog") {
        env.AZDO_OPERATIONS_FILE = join(dir, "bad.yaml");
        await writeFile(env.AZDO_OPERATIONS_FILE, "unexpected: TOKEN_SENTINEL");
      }
      if (kind === "lock") {
        env.AZDO_OPERATIONS_FILE = resolve("examples/operations.ids.yaml");
        await store.open();
      }
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", "src/index.ts"],
        { env, encoding: "utf8", timeout: 10000 },
      );
      assert.equal(child.status, 1, child.stderr);
      const output = child.stdout + child.stderr;
      assert.ok(!output.includes("TOKEN_SENTINEL"));
      assert.equal(child.stdout, "");
      const row = JSON.parse(child.stderr.trim()) as {
        event: string;
        code: string;
      };
      assert.equal(row.event, "startup_failed");
      assert.equal(
        row.code,
        kind === "configuration"
          ? "INVALID_CONFIGURATION"
          : kind === "catalog"
            ? "INVALID_CATALOG"
            : "STORE_LOCKED",
      );
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
