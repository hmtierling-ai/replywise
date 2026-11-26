import { pickReplyTarget } from "@replywise/core";
import { aad } from "@replywise/crypto";
import { type ClassificationSource, type DraftRow, getWritingPreferences } from "@replywise/db";
import { buildReplyMime, type GmailDraftsApi, toBase64Url } from "@replywise/mail";
import { NoRecipientError } from "./generation-errors";
import type { GenerationDeps } from "./generation-shared";

/**
 * The raw (base64url MIME) reply for a draft: its body plus the user's signature, addressed to
 * and threaded on the message it answers. Throws NoRecipientError or InvalidRecipientError.
 * Used by both the save job and the send job, so Gmail always holds the same message.
 */
export async function buildDraftRaw(
  deps: Pick<GenerationDeps, "db" | "encryptor">,
  draft: DraftRow,
  source: ClassificationSource,
): Promise<string> {
  const target = pickReplyTarget(source.messages, draft.forMessageId);
  if (!target) throw new NoRecipientError();
  const body = await deps.encryptor.decryptString(draft.bodyCiphertext, aad.replyDraft(draft.id));
  const { signature } = await getWritingPreferences(deps.db, source.userId);
  return toBase64Url(
    buildReplyMime({
      from: { name: null, address: source.mailboxEmail },
      to: target.fromAddress,
      subject: source.thread.subject,
      inReplyTo: target.internetMessageId,
      references: source.messages
        .map((m) => m.internetMessageId)
        .filter((id): id is string => Boolean(id)),
      body: signature ? `${body}\n\n${signature}` : body,
    }),
  );
}

/**
 * Updates the existing Gmail draft, or creates one when there is none or Gmail lost it. Used by
 * the send job only: the save job calls update/create itself because its retry rules differ per
 * call (a timed-out update is retried there, a timed-out create is not).
 */
export async function writeGmailDraft(
  api: GmailDraftsApi,
  existingId: string | null,
  input: { raw: string; threadId: string },
): Promise<string> {
  if (existingId) {
    const updated = await api.updateDraft(existingId, input);
    if (updated) return updated.draftId;
  }
  return (await api.createDraft(input)).draftId;
}
