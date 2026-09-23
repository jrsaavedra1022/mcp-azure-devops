import {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  readdir,
  rmdir,
} from "node:fs/promises";
import { join } from "node:path";
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  randomUUID,
} from "node:crypto";
import { AppError } from "../errors.js";
export interface RecordStore<T extends { id: string }> {
  put(record: T): Promise<void>;
  get(id: string): Promise<T>;
  list(): Promise<T[]>;
}
// Single local coordinator. Never silently break a stale lock after a crash.
export class EncryptedStore<
  T extends { id: string },
> implements RecordStore<T> {
  private key!: Buffer;
  private locked = false;
  constructor(
    private directory: string,
    private options: { allowIncompleteMigration?: boolean } = {},
  ) {}
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      await mkdir(join(this.directory, "coordinator.lock"));
      this.locked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new AppError(
          "STATE_UNAVAILABLE",
          "State coordinator cannot be opened.",
        );
      throw new AppError(
        "STORE_LOCKED",
        "Another coordinator owns this state directory, or recovery is required. See operations guide.",
      );
    }
    try {
      if (!this.options.allowIncompleteMigration) {
        try {
          await readFile(join(this.directory, "migration.pending"));
          throw new AppError(
            "STATE_MIGRATION_INCOMPLETE",
            "History import was interrupted. Resume the same import before connecting.",
          );
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
      const path = join(this.directory, "key");
      try {
        await writeFile(path, randomBytes(32), { flag: "wx", mode: 0o600 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      this.key = await readFile(path);
      if (this.key.length !== 32) throw new Error("Invalid key");
    } catch (e) {
      await this.close();
      throw e;
    }
  }
  private file(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new AppError("INVALID_ID", "Invalid operation ID.");
    return join(this.directory, id + ".enc");
  }
  async put(record: T) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(record), "utf8"),
      cipher.final(),
    ]);
    const tmp = this.file(record.id) + "." + randomUUID() + ".tmp";
    await writeFile(tmp, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), {
      mode: 0o600,
      flag: "wx",
    });
    try {
      await rename(tmp, this.file(record.id));
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }
  async get(id: string): Promise<T> {
    try {
      const data = await readFile(this.file(id));
      const cipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        data.subarray(0, 12),
      );
      cipher.setAuthTag(data.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([
          cipher.update(data.subarray(28)),
          cipher.final(),
        ]).toString("utf8"),
      ) as T;
    } catch {
      throw new AppError(
        "STATE_UNAVAILABLE",
        "Operation state is missing or cannot be decrypted.",
      );
    }
  }
  async list() {
    const result: T[] = [];
    for (const name of await readdir(this.directory))
      if (name.endsWith(".enc")) result.push(await this.get(name.slice(0, -4)));
    return result;
  }
  async close() {
    if (this.locked) {
      await rmdir(join(this.directory, "coordinator.lock"));
      this.locked = false;
    }
  }
}
