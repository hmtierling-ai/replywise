import {
  CLASSIFY_MAX_MESSAGES,
  type ClassifyInput,
  htmlToText,
  stripQuotedReply,
} from "@replywise/ai";
import type { Encryptor } from "@replywise/crypto";
import type { ClassificationSource } from "@replywise/db";
import { decryptBody } from "@replywise/sync";

/** Plain-text view of the newest messages; falls back to the snippet when no body is cached. */
export async function buildThreadInput(
  encryptor: Encryptor,
  source: ClassificationSource,
): Promise<ClassifyInput> {
  const recent = source.messages.slice(-CLASSIFY_MAX_MESSAGES);
  const messages: ClassifyInput["messages"] = [];
  for (const m of recent) {
    let text = m.snippet;
    if (m.bodyCiphertext) {
      const body = await decryptBody(encryptor, m.id, m.bodyCiphertext);
      text = body.text ?? (body.html ? htmlToText(body.html) : null) ?? m.snippet;
    }
    messages.push({
      from: m.fromAddress,
      to: m.toAddresses,
      sentAt: m.sentAt,
      isFromUser: m.isFromUser,
      text: stripQuotedReply(text) || m.snippet,
      hasAttachments: m.hasAttachments,
    });
  }
  return { mailboxEmail: source.mailboxEmail, subject: source.thread.subject, messages };
}
