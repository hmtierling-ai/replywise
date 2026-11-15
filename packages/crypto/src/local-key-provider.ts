import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DecryptionError } from "./errors";
import type { KeyProvider } from "./key-provider";

const KEK_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** KEKs supplied via environment. For development, tests and small self-hosted installs. */
export class LocalKeyProvider implements KeyProvider {
  readonly currentKeyId: string;
  readonly #keks = new Map<string, Buffer>();

  constructor(keks: ReadonlyArray<{ id: string; key: Buffer }>) {
    for (const { id, key } of keks) {
      if (key.length !== KEK_BYTES) throw new Error(`Key "${id}" must be ${KEK_BYTES} bytes`);
      if (this.#keks.has(id)) throw new Error(`Duplicate key id "${id}"`);
      this.#keks.set(id, key);
    }
    const current = keks.at(-1);
    if (!current) throw new Error("LocalKeyProvider requires at least one key");
    this.currentKeyId = current.id;
  }

  /** Parses `id:base64,id:base64` — the last entry is the current key. */
  static fromEnv(value: string): LocalKeyProvider {
    const keks = value.split(",").map((entry) => {
      const separator = entry.indexOf(":");
      if (separator <= 0) throw new Error("LOCAL_KEKS entries must look like id:base64");
      return {
        id: entry.slice(0, separator).trim(),
        key: Buffer.from(entry.slice(separator + 1).trim(), "base64"),
      };
    });
    return new LocalKeyProvider(keks);
  }

  async wrapKey(dataKey: Buffer, keyId: string): Promise<Buffer> {
    const kek = this.#kek(keyId);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", kek, iv);
    cipher.setAAD(Buffer.from(`kek:${keyId}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  async unwrapKey(wrappedKey: Buffer, keyId: string): Promise<Buffer> {
    const kek = this.#kek(keyId);
    if (wrappedKey.length <= IV_BYTES + TAG_BYTES) throw new DecryptionError();
    const decipher = createDecipheriv("aes-256-gcm", kek, wrappedKey.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(`kek:${keyId}`, "utf8"));
    decipher.setAuthTag(wrappedKey.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    try {
      return Buffer.concat([
        decipher.update(wrappedKey.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
    } catch {
      throw new DecryptionError();
    }
  }

  #kek(keyId: string): Buffer {
    const kek = this.#keks.get(keyId);
    if (!kek) throw new DecryptionError(`Unknown key id "${keyId}"`);
    return kek;
  }
}
