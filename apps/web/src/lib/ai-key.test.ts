import { describe, expect, it } from "vitest";
import { keyHint, parseAnthropicKey } from "./ai-key";

describe("parseAnthropicKey", () => {
  it("accepts trimmed sk-ant- keys and rejects anything else", () => {
    const key = `sk-ant-api03-${"a".repeat(40)}`;
    expect(parseAnthropicKey(`  ${key}\n`)).toBe(key);
    expect(parseAnthropicKey("sk-ant-short")).toBeNull();
    expect(parseAnthropicKey(`sk-proj-${"a".repeat(40)}`)).toBeNull();
    expect(parseAnthropicKey(`${key} extra`)).toBeNull();
  });
  it("shows only the last four characters", () => {
    expect(keyHint("sk-ant-api03-xyz9876")).toBe("9876");
  });
});
