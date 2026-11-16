import { aad, type Encryptor } from "@replywise/crypto";
import type { OAuthTokens } from "@replywise/mail";

export function encryptTokens(
  encryptor: Encryptor,
  mailAccountId: string,
  tokens: OAuthTokens,
): Promise<Buffer> {
  return encryptor.encrypt(JSON.stringify(tokens), aad.mailTokens(mailAccountId));
}

export async function decryptTokens(
  encryptor: Encryptor,
  mailAccountId: string,
  blob: Buffer,
): Promise<OAuthTokens> {
  const parsed: unknown = JSON.parse(
    await encryptor.decryptString(blob, aad.mailTokens(mailAccountId)),
  );
  const t = parsed as Partial<OAuthTokens>;
  if (
    typeof t.accessToken !== "string" ||
    typeof t.refreshToken !== "string" ||
    typeof t.expiresAt !== "string"
  ) {
    throw new Error("Stored mailbox tokens are malformed");
  }
  return { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt };
}
