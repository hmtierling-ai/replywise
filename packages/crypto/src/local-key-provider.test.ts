import { describe, expect, it } from "vitest";
import { DecryptionError } from "./errors";
import { LocalKeyProvider } from "./local-key-provider";

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");

describe("LocalKeyProvider", () => {
  it("uses the last key in the list as the current key", () => {
    const provider = LocalKeyProvider.fromEnv(`v1:${key(1)},v2:${key(2)}`);
    expect(provider.currentKeyId).toBe("v2");
  });

  it("wraps and unwraps a data key", async () => {
    const provider = LocalKeyProvider.fromEnv(`v1:${key(1)}`);
    const dataKey = Buffer.alloc(32, 9);
    const wrapped = await provider.wrapKey(dataKey, "v1");
    expect(wrapped.equals(dataKey)).toBe(false);
    expect((await provider.unwrapKey(wrapped, "v1")).equals(dataKey)).toBe(true);
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => LocalKeyProvider.fromEnv(`v1:${Buffer.alloc(16).toString("base64")}`)).toThrow(
      /32 bytes/,
    );
  });

  it("rejects malformed entries and duplicate ids", () => {
    expect(() => LocalKeyProvider.fromEnv("nocolon")).toThrow(/id:base64/);
    expect(() => LocalKeyProvider.fromEnv(`v1:${key(1)},v1:${key(2)}`)).toThrow(/Duplicate/);
  });

  it("fails to unwrap with an unknown key id", async () => {
    const provider = LocalKeyProvider.fromEnv(`v1:${key(1)}`);
    const wrapped = await provider.wrapKey(Buffer.alloc(32), "v1");
    await expect(provider.unwrapKey(wrapped, "v9")).rejects.toBeInstanceOf(DecryptionError);
  });
});
