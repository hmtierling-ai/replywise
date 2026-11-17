import { aad, type Encryptor } from "@replywise/crypto";

export interface MessageBody {
  text: string | null;
  html: string | null;
}

export function encryptBody(
  encryptor: Encryptor,
  messageId: string,
  body: MessageBody,
): Promise<Buffer> {
  return encryptor.encrypt(JSON.stringify(body), aad.messageBody(messageId));
}

export async function decryptBody(
  encryptor: Encryptor,
  messageId: string,
  blob: Buffer,
): Promise<MessageBody> {
  const parsed = JSON.parse(await encryptor.decryptString(blob, aad.messageBody(messageId))) as {
    text?: unknown;
    html?: unknown;
  };
  return {
    text: typeof parsed.text === "string" ? parsed.text : null,
    html: typeof parsed.html === "string" ? parsed.html : null,
  };
}
