"use server";

import { isMailProviderId } from "@replywise/core";
import { setAutoDraft } from "@replywise/db";
import {
  ConnectError,
  disconnectMailbox,
  MAILBOXES_PATH,
  MailAccountNotFoundError,
  startConnect,
} from "@replywise/mailbox";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getMailboxDeps, oauthCallbackUrl, requestContext } from "@/lib/mailbox";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Starts the OAuth flow. POST-only (Server Action), so other sites cannot trigger it. */
export async function connectMailboxAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const provider = String(formData.get("provider") ?? "");
  if (!isMailProviderId(provider)) redirect(`${MAILBOXES_PATH}?error=not_configured`);
  const loginHint = String(formData.get("loginHint") ?? "").trim();

  let authorizationUrl: string;
  try {
    authorizationUrl = await startConnect(getMailboxDeps(), {
      userId: user.id,
      provider,
      redirectUri: oauthCallbackUrl(provider),
      ...(loginHint ? { loginHint } : {}),
    });
  } catch (error) {
    if (error instanceof ConnectError) redirect(`${MAILBOXES_PATH}?error=${error.reason}`);
    throw error;
  }
  redirect(authorizationUrl);
}

export async function setAutoDraftAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const mailAccountId = String(formData.get("mailAccountId") ?? "");
  if (!UUID_RE.test(mailAccountId)) redirect(MAILBOXES_PATH);
  await setAutoDraft(getDb(), user.id, mailAccountId, formData.get("enabled") === "on");
  redirect(MAILBOXES_PATH);
}

export async function disconnectMailboxAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const mailAccountId = String(formData.get("mailAccountId") ?? "");

  if (!UUID_RE.test(mailAccountId)) redirect(MAILBOXES_PATH);

  let target: string;
  try {
    const result = await disconnectMailbox(getMailboxDeps(), {
      userId: user.id,
      mailAccountId,
      context: requestContext(await headers()),
    });
    target = `${MAILBOXES_PATH}?disconnected=${result.provider}${result.revoked ? "" : "&manual=1"}`;
  } catch (error) {
    if (error instanceof MailAccountNotFoundError) target = MAILBOXES_PATH;
    else throw error;
  }
  redirect(target);
}
