import type { Encryptor } from "@replywise/crypto";
import {
  type DbExecutor,
  deleteMessagesNotIn,
  deleteThreadsByProviderIds,
  getBodyCacheDays,
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
    for (const message of thread.messages) {
      const messageId = await upsertMessage(tx, threadId, account.id, {
        providerMessageId: message.providerMessageId,
        internetMessageId: message.internetMessageId,
        fromAddress: message.from,
        toAddresses: message.to,
        ccAddresses: message.cc,
        subject: message.subject,
        snippet: message.snippet,
        sentAt: message.sentAt,
        // SENT covers send-as aliases; the address check covers providers/tests without labels.
        isFromUser: message.labelIds.includes("SENT") || message.from.address === owner,
        hasAttachments: message.hasAttachments,
      });
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
  }
}
