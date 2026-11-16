import { createHash, randomBytes } from "node:crypto";

/** Cryptographically random, base64url-encoded token (32 bytes → 43 chars). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** The raw OAuth state is never stored; only this hash is. */
export function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}
