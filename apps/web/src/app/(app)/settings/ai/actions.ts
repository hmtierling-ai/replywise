"use server";

import { isAiModel, isClassificationModel, REPLY_TONES, type ReplyTone } from "@replywise/core";
import { aad } from "@replywise/crypto";
import {
  deleteAiCredential,
  insertAuditLog,
  saveAiCredential,
  setClassificationModel,
  setWritingPreferences,
} from "@replywise/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAiProvider } from "@/lib/ai";
import { saveAnthropicKey } from "@/lib/ai-settings";
import { requireUser } from "@/lib/auth";
import { getEncryptor } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { requestContext } from "@/lib/mailbox";

const AI_PATH = "/settings/ai";

export async function saveAiKeyAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const context = requestContext(await headers());
  const db = getDb();
  const result = await saveAnthropicKey(
    {
      validate: (key) => getAiProvider().validateKey(key),
      encrypt: (key) => getEncryptor().encrypt(key, aad.aiCredential(user.id, "anthropic")),
      save: (input) => saveAiCredential(db, input),
      audit: ({ userId, keyHint }) =>
        insertAuditLog(db, {
          userId,
          action: "ai_key.updated",
          targetType: "ai_credential",
          targetId: userId,
          metadata: { provider: "anthropic", keyHint },
          ip: context.ip,
          userAgent: context.userAgent,
        }),
      now: () => new Date(),
    },
    { userId: user.id, rawKey: String(formData.get("apiKey") ?? "") },
  );
  redirect(result === "saved" ? `${AI_PATH}?saved=saved` : `${AI_PATH}?error=${result}`);
}

export async function deleteAiKeyAction(): Promise<void> {
  const user = await requireUser();
  const context = requestContext(await headers());
  const db = getDb();
  if (await deleteAiCredential(db, user.id)) {
    await insertAuditLog(db, {
      userId: user.id,
      action: "ai_key.deleted",
      targetType: "ai_credential",
      targetId: user.id,
      metadata: { provider: "anthropic" },
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }
  redirect(`${AI_PATH}?saved=removed`);
}

export async function setClassificationModelAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const model = String(formData.get("model") ?? "");
  if (!isClassificationModel(model)) redirect(`${AI_PATH}?error=invalid_model`);
  await setClassificationModel(getDb(), user.id, model);
  redirect(`${AI_PATH}?saved=model`);
}

export async function saveWritingPreferencesAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const tone = String(formData.get("defaultTone") ?? "");
  const model = String(formData.get("generationModel") ?? "");
  const language = String(formData.get("replyLanguage") ?? "")
    .replace(/[\r\n"<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!(REPLY_TONES as readonly string[]).includes(tone) || !isAiModel(model)) {
    redirect(`${AI_PATH}?error=invalid_preferences`);
  }
  await setWritingPreferences(getDb(), user.id, {
    defaultTone: tone as ReplyTone,
    generationModel: model,
    signature: String(formData.get("signature") ?? "").slice(0, 1_000),
    writingStyleNotes: String(formData.get("writingStyleNotes") ?? "").slice(0, 2_000),
    replyLanguage: language ? language.slice(0, 35) : null,
  });
  redirect(`${AI_PATH}?saved=writing`);
}
