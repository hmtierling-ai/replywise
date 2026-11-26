"use server";

import { aad } from "@replywise/crypto";
import {
  countRecentSends,
  getDraftForUser,
  getDraftMailbox,
  insertAuditLog,
  reopenFailedSend,
  SEND_DELAY_MS,
  SEND_RATE_LIMIT,
  scheduleSend,
  undoSend,
} from "@replywise/db";
import { sendJobId } from "@replywise/queue";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireUser } from "@/lib/auth";
import { getEncryptor } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { normalizeBody } from "@/lib/draft-body";
import type { SendActionErrorCode } from "@/lib/draft-messages";
import { requestContext } from "@/lib/mailbox";
import { getQueue } from "@/lib/queue";

export type SendActionResult = { ok: true } | { ok: false; error: SendActionErrorCode };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (error: SendActionErrorCode): SendActionResult => ({ ok: false, error });

async function audit(
  userId: string,
  action: "draft.send_scheduled" | "draft.send_undone",
  metadata: { draftId: string; threadId: string; mailAccountId: string },
): Promise<void> {
  const context = requestContext(await headers());
  // Best effort: never block or fail the user's action over the audit row.
  await insertAuditLog(getDb(), {
    userId,
    action,
    targetType: "reply_draft",
    targetId: metadata.draftId,
    metadata,
    ip: context.ip,
    userAgent: context.userAgent,
  }).catch(() => undefined);
}

/**
 * The only way a send starts (spec M6 §2.2): after the confirmation dialog. What was confirmed
 * (`expectedBody`) must equal the stored body, so exactly that text is sent after 10 seconds.
 */
export async function scheduleSendAction(input: {
  draftId: string;
  expectedBody: string;
}): Promise<SendActionResult> {
  const user = await requireUser();
  const draftId = typeof input?.draftId === "string" ? input.draftId : "";
  if (!UUID.test(draftId) || typeof input.expectedBody !== "string") return fail("not_sendable");
  const db = getDb();
  const [draft, mailbox] = await Promise.all([
    getDraftForUser(db, user.id, draftId),
    getDraftMailbox(db, user.id, draftId),
  ]);
  if (!draft || !mailbox || mailbox.provider !== "gmail") return fail("not_sendable");
  let stored: string;
  try {
    stored = await getEncryptor().decryptString(draft.bodyCiphertext, aad.replyDraft(draft.id));
  } catch {
    return fail("not_sendable");
  }
  if (stored !== normalizeBody(input.expectedBody)) return fail("draft_changed");
  const now = new Date();
  if ((await countRecentSends(db, user.id, now)) >= SEND_RATE_LIMIT) {
    return fail("send_rate_limited");
  }
  const sendAt = new Date(now.getTime() + SEND_DELAY_MS);
  // Only the ciphertext checked above may be scheduled: a save from another tab in between
  // changes it, and the conditional update then does not apply.
  if (!(await scheduleSend(db, user.id, draftId, draft.bodyCiphertext, sendAt, now))) {
    const current = await getDraftForUser(db, user.id, draftId);
    if (current && !current.bodyCiphertext.equals(draft.bodyCiphertext)) {
      return fail("draft_changed");
    }
    return fail("not_sendable");
  }
  try {
    await getQueue().enqueue(
      "draft.send",
      { draftId },
      { jobId: sendJobId(draftId, sendAt), delayMs: SEND_DELAY_MS },
    );
  } catch {
    // Without a job only the stuck-send scan would start it; give the draft back instead.
    try {
      await undoSend(db, user.id, draftId, now);
    } catch {
      // The row stays scheduled and recovery may still send it: the user must reload to undo.
      return fail("send_still_scheduled");
    }
    return fail("internal");
  }
  await audit(user.id, "draft.send_scheduled", {
    draftId,
    threadId: mailbox.threadId,
    mailAccountId: mailbox.mailAccountId,
  });
  revalidatePath(`/thread/${mailbox.threadId}`);
  return { ok: true };
}

/** scheduled → edited, only inside the undo window (before the worker claims it). */
export async function undoSendAction(input: { draftId: string }): Promise<SendActionResult> {
  const user = await requireUser();
  const draftId = typeof input?.draftId === "string" ? input.draftId : "";
  if (!UUID.test(draftId)) return fail("not_sendable");
  const db = getDb();
  const mailbox = await getDraftMailbox(db, user.id, draftId);
  if (!mailbox) return fail("not_sendable");
  // The conditional DB transition decides; the worker's claim is conditional too.
  const undone = await undoSend(db, user.id, draftId, new Date());
  if (!undone) return fail("too_late");
  if (undone.sendAt) {
    // Best effort only: a leftover (or locked) job is a no-op once the draft left `scheduled`.
    try {
      await getQueue().removeJob("send", sendJobId(draftId, undone.sendAt));
    } catch {
      // ignored by design
    }
  }
  await audit(user.id, "draft.send_undone", {
    draftId,
    threadId: mailbox.threadId,
    mailAccountId: mailbox.mailAccountId,
  });
  revalidatePath(`/thread/${mailbox.threadId}`);
  return { ok: true };
}

/** "Edit" on a failed send: back to an editable draft (acknowledges a possible send). */
export async function editFailedSendAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const draftId = String(formData.get("draftId") ?? "");
  const threadId = String(formData.get("threadId") ?? "");
  if (!UUID.test(draftId) || !UUID.test(threadId)) return;
  await reopenFailedSend(getDb(), user.id, draftId, new Date());
  revalidatePath(`/thread/${threadId}`);
}
