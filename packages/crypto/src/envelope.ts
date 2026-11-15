import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DecryptionError } from "./errors";
import type { KeyProvider } from "./key-provider";

/**
 * Blob layout:
 * version(1) | keyIdLen(1) | keyId | wrappedDekLen(2, BE) | wrappedDek | iv(12) | tag(16) | ciphertext
 */
const FORMAT_VERSION = 1;
const DEK_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface Encryptor {
  encrypt(plaintext: string | Buffer, aad: string): Promise<Buffer>;
  decrypt(blob: Buffer, aad: string): Promise<Buffer>;
  decryptString(blob: Buffer, aad: string): Promise<string>;
  keyIdOf(blob: Buffer): string;
}

interface ParsedBlob {
  keyId: string;
  wrappedKey: Buffer;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

function parse(blob: Buffer): ParsedBlob {
  const tooShort = () => new DecryptionError("Ciphertext is truncated");
  if (blob.length < 2) throw tooShort();
  let offset = 0;
  const version = blob.readUInt8(offset);
  offset += 1;
  if (version !== FORMAT_VERSION) throw new DecryptionError("Unsupported ciphertext version");
  const keyIdLength = blob.readUInt8(offset);
  offset += 1;
  if (blob.length < offset + keyIdLength + 2) throw tooShort();
  const keyId = blob.subarray(offset, offset + keyIdLength).toString("utf8");
  offset += keyIdLength;
  const wrappedLength = blob.readUInt16BE(offset);
  offset += 2;
  if (blob.length < offset + wrappedLength + IV_BYTES + TAG_BYTES) throw tooShort();
  const wrappedKey = blob.subarray(offset, offset + wrappedLength);
  offset += wrappedLength;
  const iv = blob.subarray(offset, offset + IV_BYTES);
  offset += IV_BYTES;
  const tag = blob.subarray(offset, offset + TAG_BYTES);
  offset += TAG_BYTES;
  return { keyId, wrappedKey, iv, tag, ciphertext: blob.subarray(offset) };
}

export function createEncryptor(keys: KeyProvider): Encryptor {
  async function decrypt(blob: Buffer, aad: string): Promise<Buffer> {
    const parsed = parse(blob);
    const dataKey = await keys.unwrapKey(parsed.wrappedKey, parsed.keyId);
    try {
      const decipher = createDecipheriv("aes-256-gcm", dataKey, parsed.iv);
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(parsed.tag);
      return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
    } catch {
      throw new DecryptionError("Ciphertext authentication failed");
    } finally {
      dataKey.fill(0);
    }
  }

  return {
    async encrypt(plaintext, aad) {
      const dataKey = randomBytes(DEK_BYTES);
      try {
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
        cipher.setAAD(Buffer.from(aad, "utf8"));
        const input = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
        const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
        const tag = cipher.getAuthTag();

        const keyId = keys.currentKeyId;
        const keyIdBytes = Buffer.from(keyId, "utf8");
        if (keyIdBytes.length > 255) throw new Error("Key id is too long");
        const wrappedKey = await keys.wrapKey(dataKey, keyId);
        if (wrappedKey.length > 0xffff) throw new Error("Wrapped key is too long");

        const header = Buffer.alloc(1 + 1 + keyIdBytes.length + 2);
        header.writeUInt8(FORMAT_VERSION, 0);
        header.writeUInt8(keyIdBytes.length, 1);
        keyIdBytes.copy(header, 2);
        header.writeUInt16BE(wrappedKey.length, 2 + keyIdBytes.length);
        return Buffer.concat([header, wrappedKey, iv, tag, ciphertext]);
      } finally {
        dataKey.fill(0);
      }
    },
    decrypt,
    async decryptString(blob, aad) {
      return (await decrypt(blob, aad)).toString("utf8");
    },
    keyIdOf(blob) {
      return parse(blob).keyId;
    },
  };
}
