import type { EmailAddress } from "@replywise/core";
import type { ThreadWrite } from "@replywise/db";
import type { ParsedThread } from "@replywise/mail";

/** Thread-level fields derived from its messages. The thread must have at least one message. */
export function summarizeThread(thread: ParsedThread): ThreadWrite {
  const sorted = [...thread.messages].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) throw new Error("summarizeThread needs at least one message");

  const participants: EmailAddress[] = [];
  const seen = new Set<string>();
  for (const message of sorted) {
    for (const address of [message.from, ...message.to, ...message.cc]) {
      if (address.address === "" || seen.has(address.address)) continue;
      seen.add(address.address);
      participants.push(address);
    }
  }
  const labels = new Set(sorted.flatMap((m) => m.labelIds));
  return {
    providerThreadId: thread.providerThreadId,
    subject: first.subject,
    snippet: last.snippet,
    participants,
    lastMessageAt: last.sentAt,
    messageCount: sorted.length,
    isUnread: labels.has("UNREAD"),
    providerLabels: [...labels].sort(),
  };
}
