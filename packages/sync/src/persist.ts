import type { Encryptor } from "@replywise/crypto";
import {
  type DbExecutor,
  deleteMessagesNotIn,
  deleteThreadsByProviderIds,
  getBodyCacheDays,
  markThreadAnswered,
  setMessageBody,
  upsertMessage,
  upsertThread,
} from "@replywise/db";
import type { ParsedThread } from "@replywise/mail";
import { encryptBody } from "./body-codec";
import { summarizeThread } from "./thread-summary";

const DAY_MS = 86_400_000;

export interface PersistAccount {
  id: string;
  userId: string;
  emailAddress: string;
}

/**
 * Writes parsed threads (inside the caller's transaction). Draft messages are dropped; threads
 * left without messages are deleted.
 */
export async function persistThreads(
  tx: DbExecutor,
  encryptor: Encryptor,
  account: PersistAccount,
  parsed: ParsedThread[],
  now: Date,
): Promise<void> {
  const expiresAt = new Date(now.getTime() + (await getBodyCacheDays(tx, account.userId)) * DAY_MS);
  const owner = account.emailAddress.toLowerCase();

  for (const fetched of parsed) {
    // Gmail returns unsent drafts inside threads; they are not mail and must not be stored.
    const thread = {
      ...fetched,
      messages: fetched.messages.filter((m) => !m.labelIds.includes("DRAFT")),
    };
    if (thread.messages.length === 0) {
      await deleteThreadsByProviderIds(tx, account.id, [thread.providerThreadId]);
      continue;
    }
    const threadId = await upsertThread(tx, account.id, summarizeThread(thread));
    // Newest kept message, ordered like the classification scan: sent_at, then id (uuid order
    // equals lowercase-hex string order).
    let newest: { sentAt: Date; id: string; isFromUser: boolean } | null = null;
    for (const message of thread.messages) {
      // SENT covers send-as aliases; the address check covers providers/tests without labels.
      const isFromUser = message.labelIds.includes("SENT") || message.from.address === owner;
      const messageId = await upsertMessage(tx, threadId, account.id, {
        providerMessageId: message.providerMessageId,
        internetMessageId: message.internetMessageId,
        fromAddress: message.from,
        toAddresses: message.to,
        ccAddresses: message.cc,
        subject: message.subject,
        snippet: message.snippet,
        sentAt: message.sentAt,
        isFromUser,
        hasAttachments: message.hasAttachments,
      });
      const sentAt = message.sentAt.getTime();
      const newestAt = newest?.sentAt.getTime() ?? Number.NEGATIVE_INFINITY;
      if (!newest || sentAt > newestAt || (sentAt === newestAt && messageId > newest.id)) {
        newest = { sentAt: message.sentAt, id: messageId, isFromUser };
      }
      // Always cache, even an empty body, so bodiless messages are not refetched on every view.
      const blob = await encryptBody(encryptor, messageId, {
        text: message.bodyText,
        html: message.bodyHtml,
      });
      await setMessageBody(tx, messageId, blob, expiresAt);
    }
    await deleteMessagesNotIn(
      tx,
      threadId,
      thread.messages.map((m) => m.providerMessageId),
    );
    // The user answered last: drop the thread out of Needs Reply now, with no AI call (the scan
    // skips it). A no-op when there is no insight or it does not need a reply.
    if (newest?.isFromUser) await markThreadAnswered(tx, threadId);
  }
}
