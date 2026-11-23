"use server";

import { isClassificationModel } from "@replywise/core";
import { aad } from "@replywise/crypto";
import {
  deleteAiCredential,
  insertAuditLog,
  saveAiCredential,
  setClassificationModel,
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
