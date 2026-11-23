import { describe, expect, it, vi } from "vitest";
import { saveAnthropicKey } from "./ai-settings";

const key = `sk-ant-api03-${"b".repeat(40)}`;

function deps(validation: { ok: true } | { ok: false; reason: "invalid" | "unreachable" }) {
  return {
    validate: vi.fn(async () => validation),
    encrypt: vi.fn(async (k: string) => Buffer.from(`enc:${k.length}`)),
    save: vi.fn(async () => {}),
    audit: vi.fn(async () => {}),
    now: () => new Date("2026-11-23T12:00:00Z"),
  };
}

describe("saveAnthropicKey", () => {
  it("rejects a malformed key without calling the provider", async () => {
    const d = deps({ ok: true });
    expect(await saveAnthropicKey(d, { userId: "u1", rawKey: "hello" })).toBe("invalid_format");
    expect(d.validate).not.toHaveBeenCalled();
    expect(d.save).not.toHaveBeenCalled();
  });

  it("validates, encrypts and stores a valid key with its hint, and audits without the key", async () => {
    const d = deps({ ok: true });
    expect(await saveAnthropicKey(d, { userId: "u1", rawKey: key })).toBe("saved");
    expect(d.encrypt).toHaveBeenCalledWith(key);
    expect(d.save).toHaveBeenCalledWith({
      userId: "u1",
      keyCiphertext: Buffer.from(`enc:${key.length}`),
      keyHint: "bbbb",
      status: "valid",
      lastValidatedAt: new Date("2026-11-23T12:00:00Z"),
    });
    expect(JSON.stringify(d.audit.mock.calls)).not.toContain(key);
  });

  it("reports a rejected or unreachable key and stores nothing", async () => {
    const rejected = deps({ ok: false, reason: "invalid" });
    expect(await saveAnthropicKey(rejected, { userId: "u1", rawKey: key })).toBe("invalid_key");
    expect(rejected.save).not.toHaveBeenCalled();
    const down = deps({ ok: false, reason: "unreachable" });
    expect(await saveAnthropicKey(down, { userId: "u1", rawKey: key })).toBe("unreachable");
    expect(down.save).not.toHaveBeenCalled();
  });
});
