"use server";

import { DEFAULT_AI_MODELS, REPLY_TONES, type ReplyTone } from "@replywise/core";
import { aad } from "@replywise/crypto";
import {
  createPendingDraft,
  discardDraft,
  failDraft,
  failDraftSave,
  failSummary,
  getAiCredentialSummary,
  getDraftForUser,
  getWritingPreferences,
  hasFreshPendingDraft,
  requestDraftSave,
  requestSummary,
  threadBelongsToUser,
  updateDraftBody,
} from "@replywise/db";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getEncryptor } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { getQueue } from "@/lib/queue";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INSTRUCTIONS = 2_000;
const MAX_BODY = 20_000;

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "");
}

function normalizeBody(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").slice(0, MAX_BODY);
}

async function ownedThread(userId: string, formData: FormData): Promise<string | null> {
  const threadId = field(formData, "threadId");
  if (!UUID.test(threadId)) return null;
  return (await threadBelongsToUser(getDb(), userId, threadId)) ? threadId : null;
}

async function hasValidKey(userId: string): Promise<boolean> {
  return (await getAiCredentialSummary(getDb(), userId))?.status === "valid";
}

export async function summarizeThreadAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const threadId = await ownedThread(user.id, formData);
  if (!threadId || !(await hasValidKey(user.id))) return;
  const now = new Date();
  // False while a fresh pending request exists: no second paid call.
  if (await requestSummary(getDb(), threadId, now)) {
    try {
      await getQueue().enqueue(
        "thread.summarize",
        { threadId },
        { jobId: `summarize_${threadId}_${now.getTime()}` },
      );
    } catch {
      await failSummary(getDb(), threadId, "internal");
    }
  }
  revalidatePath(`/thread/${threadId}`);
}

export async function generateDraftAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const threadId = await ownedThread(user.id, formData);
  if (!threadId || !(await hasValidKey(user.id))) return;
  if (await hasFreshPendingDraft(getDb(), user.id, threadId, new Date())) return;
  const prefs = await getWritingPreferences(getDb(), user.id);
  const toneValue = field(formData, "tone");
  const tone: ReplyTone = (REPLY_TONES as readonly string[]).includes(toneValue)
    ? (toneValue as ReplyTone)
    : prefs.defaultTone;
  const instructions = field(formData, "instructions").trim().slice(0, MAX_INSTRUCTIONS) || null;
  let draftId: string;
  try {
    draftId = await createPendingDraft(getDb(), {
      threadId,
      userId: user.id,
      tone,
      instructions,
      forMessageId: null,
      // Placeholder, never decrypted: completeDraft replaces it (AAD is per draft id, unknown before insert).
      placeholderCiphertext: await getEncryptor().encrypt("", aad.replyDraft("pending")),
      aiProvider: "anthropic",
      model: prefs.generationModel || DEFAULT_AI_MODELS.generation,
    });
  } catch (error) {
    // Ownership was checked above, so this is unreachable in practice.
    if (error instanceof Error && error.message === "thread_not_owned") return;
    throw error;
  }
  try {
    await getQueue().enqueue("draft.generate", { draftId }, { jobId: `draft_${draftId}` });
  } catch {
    await failDraft(getDb(), draftId, "internal");
  }
  revalidatePath(`/thread/${threadId}`);
}

export async function saveDraftEditAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const threadId = await ownedThread(user.id, formData);
  const draftId = field(formData, "draftId");
  if (!threadId || !UUID.test(draftId)) return;
  const draft = await getDraftForUser(getDb(), user.id, draftId);
  if (!draft || draft.threadId !== threadId) return;
  const body = normalizeBody(field(formData, "body"));
  if (!body.trim()) return;
  await updateDraftBody(
    getDb(),
    user.id,
    draftId,
    await getEncryptor().encrypt(body, aad.replyDraft(draftId)),
  );
  revalidatePath(`/thread/${threadId}`);
}

export async function saveDraftToGmailAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const threadId = await ownedThread(user.id, formData);
  const draftId = field(formData, "draftId");
  if (!threadId || !UUID.test(draftId)) return;
  const draft = await getDraftForUser(getDb(), user.id, draftId);
  if (!draft || draft.threadId !== threadId) return;
  if (draft.status !== "generated" && draft.status !== "edited" && draft.status !== "saved") return;
  const body = normalizeBody(field(formData, "body"));
  // Persist unsaved edits first so Gmail gets exactly what the user sees; an untouched body is
  // not rewritten, so a generated draft stays "generated".
  if (body.trim()) {
    const enc = getEncryptor();
    const current = await enc.decryptString(draft.bodyCiphertext, aad.replyDraft(draft.id));
    if (current !== body) {
      await updateDraftBody(
        getDb(),
        user.id,
        draftId,
        await enc.encrypt(body, aad.replyDraft(draftId)),
      );
    }
  }
  const now = new Date();
  if (await requestDraftSave(getDb(), user.id, draftId, now)) {
    try {
      await getQueue().enqueue(
        "draft.save",
        { draftId },
        { jobId: `save_${draftId}_${now.getTime()}` },
      );
    } catch {
      await failDraftSave(getDb(), draftId, "internal");
    }
  }
  revalidatePath(`/thread/${threadId}`);
}

export async function discardDraftAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const threadId = await ownedThread(user.id, formData);
  const draftId = field(formData, "draftId");
  if (!threadId || !UUID.test(draftId)) return;
  const draft = await getDraftForUser(getDb(), user.id, draftId);
  if (!draft || draft.threadId !== threadId) return;
  await discardDraft(getDb(), user.id, draftId);
  revalidatePath(`/thread/${threadId}`);
}
