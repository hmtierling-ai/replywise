import type { KeyValidation } from "@replywise/ai";
import { keyHint, parseAnthropicKey } from "./ai-key";

export type SaveKeyResult = "saved" | "invalid_format" | "invalid_key" | "unreachable";

export interface SaveKeyDeps {
  validate(key: string): Promise<KeyValidation>;
  encrypt(key: string): Promise<Buffer>;
  save(input: {
    userId: string;
    keyCiphertext: Buffer;
    keyHint: string;
    status: "valid";
    lastValidatedAt: Date;
  }): Promise<void>;
  /** Audit entry without any key material. */
  audit(input: { userId: string; keyHint: string }): Promise<void>;
  now(): Date;
}

/** Format check → live check → encrypt → store. Only valid keys are stored. */
export async function saveAnthropicKey(
  deps: SaveKeyDeps,
  input: { userId: string; rawKey: string },
): Promise<SaveKeyResult> {
  const key = parseAnthropicKey(input.rawKey);
  if (!key) return "invalid_format";
  const validation = await deps.validate(key);
  if (!validation.ok) return validation.reason === "invalid" ? "invalid_key" : "unreachable";
  await deps.save({
    userId: input.userId,
    keyCiphertext: await deps.encrypt(key),
    keyHint: keyHint(key),
    status: "valid",
    lastValidatedAt: deps.now(),
  });
  await deps.audit({ userId: input.userId, keyHint: keyHint(key) });
  return "saved";
}
