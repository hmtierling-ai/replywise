export const MAIL_PROVIDERS = ["gmail", "outlook"] as const;
export type MailProviderId = (typeof MAIL_PROVIDERS)[number];

export function isMailProviderId(value: string): value is MailProviderId {
  return (MAIL_PROVIDERS as readonly string[]).includes(value);
}

export interface EmailAddress {
  name: string | null;
  address: string;
}

/**
 * The message a reply answers (messages oldest first): the pinned one if it is not the user's
 * own, else the newest message from someone else. Shared by the worker and the send dialog.
 */
export function pickReplyTarget<M extends { id: string; isFromUser: boolean }>(
  messages: readonly M[],
  forMessageId: string | null,
): M | null {
  const pinned = forMessageId
    ? messages.find((m) => m.id === forMessageId && !m.isFromUser)
    : undefined;
  return pinned ?? messages.findLast((m) => !m.isFromUser) ?? null;
}

/** "Re: <subject>" unless it already starts with Re:, on one line. */
export function replySubject(subject: string): string {
  const s = subject.replace(/[\r\n]+/g, " ").trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}
