import type { EmailAddress, MailProviderId } from "@replywise/core";
import { getThreadForUser } from "@replywise/db";
import { getValidAccessToken } from "@replywise/mailbox";
import { decryptBody, type MessageBody } from "./body-codec";
import type { SyncDeps } from "./deps";
import { persistThreads } from "./persist";

export interface ThreadViewMessage {
  id: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  sentAt: Date;
  isFromUser: boolean;
  snippet: string;
  body: MessageBody | null;
}

export interface ThreadView {
  id: string;
  subject: string;
  providerThreadId: string;
  mailbox: { provider: MailProviderId; emailAddress: string };
  messages: ThreadViewMessage[];
  /** True when some bodies were missing and could not be refetched from the provider. */
  bodiesUnavailable: boolean;
}

/**
 * Loads a thread the user owns, decrypting cached bodies. Bodies whose cache expired are
 * refetched from Gmail and cached again; if that fails the view still renders with snippets.
 */
export async function loadThreadForUser(
  deps: SyncDeps,
  userId: string,
  threadId: string,
): Promise<ThreadView | null> {
  let detail = await getThreadForUser(deps.db, userId, threadId);
  if (!detail) return null;

  const missing = detail.messages.some((m) => m.bodyCiphertext === null);
  let bodiesUnavailable = false;
  if (missing) {
    try {
      if (detail.mailbox.provider !== "gmail" || detail.mailbox.status === "needs_reauth") {
        throw new Error("cannot refetch");
      }
      const { accessToken } = await getValidAccessToken(deps, detail.mailbox.id);
      const thread = await deps.gmail(accessToken).getThread(detail.thread.providerThreadId);
      if (thread) {
        const mailbox = {
          id: detail.mailbox.id,
          userId,
          emailAddress: detail.mailbox.emailAddress,
        };
        await deps.db.transaction((tx) =>
          persistThreads(tx, deps.encryptor, mailbox, [thread], new Date()),
        );
        detail = (await getThreadForUser(deps.db, userId, threadId)) ?? detail;
      }
      bodiesUnavailable = detail.messages.some((m) => m.bodyCiphertext === null);
    } catch {
      bodiesUnavailable = true;
    }
  }

  const messages: ThreadViewMessage[] = [];
  for (const m of detail.messages) {
    messages.push({
      id: m.id,
      from: m.fromAddress,
      to: m.toAddresses,
      cc: m.ccAddresses,
      sentAt: m.sentAt,
      isFromUser: m.isFromUser,
      snippet: m.snippet,
      body: m.bodyCiphertext ? await decryptBody(deps.encryptor, m.id, m.bodyCiphertext) : null,
    });
  }
  return {
    id: detail.thread.id,
    subject: detail.thread.subject,
    providerThreadId: detail.thread.providerThreadId,
    mailbox: { provider: detail.mailbox.provider, emailAddress: detail.mailbox.emailAddress },
    messages,
    bodiesUnavailable,
  };
}
