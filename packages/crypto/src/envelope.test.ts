import { describe, expect, it } from "vitest";
import { aad } from "./aad";
import { createEncryptor } from "./envelope";
import { DecryptionError } from "./errors";
import { LocalKeyProvider } from "./local-key-provider";

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const v1Only = LocalKeyProvider.fromEnv(`v1:${key(1)}`);
const v1AndV2 = LocalKeyProvider.fromEnv(`v1:${key(1)},v2:${key(2)}`);
const v2Only = LocalKeyProvider.fromEnv(`v2:${key(2)}`);
const AAD = aad.aiCredential("user_123", "anthropic");

describe("envelope encryption", () => {
  it("round-trips a string", async () => {
    const enc = createEncryptor(v1Only);
    const blob = await enc.encrypt("sk-ant-secret-value", AAD);
    expect(await enc.decryptString(blob, AAD)).toBe("sk-ant-secret-value");
  });

  it("round-trips binary data", async () => {
    const enc = createEncryptor(v1Only);
    const data = Buffer.from([0, 1, 2, 255, 254]);
    expect((await enc.decrypt(await enc.encrypt(data, AAD), AAD)).equals(data)).toBe(true);
  });

  it("never contains the plaintext and never repeats ciphertext", async () => {
    const enc = createEncryptor(v1Only);
    const a = await enc.encrypt("same plaintext", AAD);
    const b = await enc.encrypt("same plaintext", AAD);
    expect(a.equals(b)).toBe(false);
    expect(a.includes(Buffer.from("same plaintext"))).toBe(false);
  });

  it("fails with a different associated data (row swap)", async () => {
    const enc = createEncryptor(v1Only);
    const blob = await enc.encrypt("secret", AAD);
    await expect(
      enc.decrypt(blob, aad.aiCredential("user_456", "anthropic")),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it("fails when any ciphertext byte is tampered with", async () => {
    const enc = createEncryptor(v1Only);
    const blob = await enc.encrypt("secret", AAD);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    await expect(enc.decrypt(tampered, AAD)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("fails on an unknown format version and on truncated input", async () => {
    const enc = createEncryptor(v1Only);
    const blob = await enc.encrypt("secret", AAD);
    const wrongVersion = Buffer.from(blob);
    wrongVersion[0] = 99;
    await expect(enc.decrypt(wrongVersion, AAD)).rejects.toBeInstanceOf(DecryptionError);
    await expect(enc.decrypt(blob.subarray(0, 10), AAD)).rejects.toBeInstanceOf(DecryptionError);
    await expect(enc.decrypt(Buffer.alloc(0), AAD)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("supports key rotation: old blobs decrypt, new blobs use the newest key", async () => {
    const old = await createEncryptor(v1Only).encrypt("secret", AAD);
    const rotated = createEncryptor(v1AndV2);
    expect(rotated.keyIdOf(old)).toBe("v1");
    expect(await rotated.decryptString(old, AAD)).toBe("secret");
    expect(rotated.keyIdOf(await rotated.encrypt("secret", AAD))).toBe("v2");
  });

  it("fails when the key that wrapped the blob was removed", async () => {
    const old = await createEncryptor(v1Only).encrypt("secret", AAD);
    await expect(createEncryptor(v2Only).decrypt(old, AAD)).rejects.toBeInstanceOf(DecryptionError);
  });
});

describe("aad helpers", () => {
  it("produce distinct, namespaced strings", () => {
    const values = [
      aad.aiCredential("u1", "anthropic"),
      aad.mailTokens("m1"),
      aad.messageBody("m1"),
      aad.replyDraft("m1"),
      aad.oauthVerifier("m1"),
    ];
    expect(new Set(values).size).toBe(values.length);
  });
});
