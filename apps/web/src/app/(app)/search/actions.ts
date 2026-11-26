"use server";

import { GMAIL_QUERY_MAX_CHARS, importThread, searchGmailThreads } from "@replywise/sync";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getLimiterStore } from "@/lib/redis-limiter";
import { acquireGmailSearchSlot, countGmailRequest } from "@/lib/search-limit";
import { type GmailSearchErrorCode, gmailSearchErrorCode } from "@/lib/search-messages";
import { getGmailSearchDeps } from "@/lib/sync";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Gmail thread ids are hex; allow the URL-safe alphabet and nothing that could form a path. */
const PROVIDER_THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface GmailSearchHit {
  providerThreadId: string;
  subject: string;
  from: string;
  /** ISO 8601. */
  date: string;
  snippet: string;
  localThreadId: string | null;
}

export type GmailSearchResponse =
  | { ok: true; hits: GmailSearchHit[] }
  | { ok: false; error: GmailSearchErrorCode };

/** "Search all of Gmail" for one of the user's mailboxes. The query is never logged. */
export async function searchGmailAction(input: {
  mailAccountId: string;
  q: string;
}): Promise<GmailSearchResponse> {
  const user = await requireUser();
  const mailAccountId = typeof input?.mailAccountId === "string" ? input.mailAccountId : "";
  const q = typeof input?.q === "string" ? input.q.trim() : "";
  if (!UUID.test(mailAccountId) || q.length === 0 || q.length > GMAIL_QUERY_MAX_CHARS) {
    return { ok: false, error: "invalid_query" };
  }
  let release: () => Promise<void>;
  try {
    const slot = await acquireGmailSearchSlot(getLimiterStore(), user.id, Date.now());
    if (!slot.ok) return { ok: false, error: "rate_limited" };
    release = slot.release;
  } catch {
    return { ok: false, error: "gmail_error" };
  }
  try {
    const results = await searchGmailThreads(getGmailSearchDeps(), {
      userId: user.id,
      mailAccountId,
      query: q,
    });
    return {
      ok: true,
      hits: results.map((r) => ({
        providerThreadId: r.providerThreadId,
        subject: r.subject,
        from: r.from.name ?? r.from.address,
        date: r.date.toISOString(),
        snippet: r.snippet,
        localThreadId: r.localThreadId,
      })),
    };
  } catch (error) {
    return { ok: false, error: gmailSearchErrorCode(error) };
  } finally {
    await release().catch(() => undefined);
  }
}

/** Imports one Gmail thread, then opens it. Only failures return. */
export async function importGmailThreadAction(input: {
  mailAccountId: string;
  providerThreadId: string;
}): Promise<{ ok: false; error: GmailSearchErrorCode }> {
  const user = await requireUser();
  const mailAccountId = typeof input?.mailAccountId === "string" ? input.mailAccountId : "";
  const providerThreadId =
    typeof input?.providerThreadId === "string" ? input.providerThreadId : "";
  if (!UUID.test(mailAccountId) || !PROVIDER_THREAD_ID.test(providerThreadId)) {
    return { ok: false, error: "invalid_query" };
  }
  try {
    if (!(await countGmailRequest(getLimiterStore(), user.id, Date.now()))) {
      return { ok: false, error: "rate_limited" };
    }
  } catch {
    return { ok: false, error: "gmail_error" };
  }
  let threadId: string | null;
  try {
    threadId = await importThread(getGmailSearchDeps(), {
      userId: user.id,
      mailAccountId,
      providerThreadId,
    });
  } catch (error) {
    return { ok: false, error: gmailSearchErrorCode(error) };
  }
  if (!threadId) return { ok: false, error: "gmail_error" };
  // Outside the try: redirect() works by throwing.
  redirect(`/thread/${threadId}`);
}
