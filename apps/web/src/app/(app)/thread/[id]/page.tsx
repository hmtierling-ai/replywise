import { aad } from "@replywise/crypto";
import {
  getAiCredentialSummary,
  getSummary,
  getThreadInsight,
  getWritingPreferences,
  listDraftsForThread,
  PENDING_STALE_MS,
  SAVE_STALE_MS,
} from "@replywise/db";
import { loadThreadForUser } from "@replywise/sync";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import type { DraftView } from "@/components/thread/reply-composer";
import { ThreadView } from "@/components/thread/thread-view";
import { requireUser } from "@/lib/auth";
import { getEncryptor } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { isOlderThan } from "@/lib/stale";
import { getSyncDeps } from "@/lib/sync";

export const metadata = { title: "Thread" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ThreadContent({ params }: { params: PageProps<"/thread/[id]">["params"] }) {
  const user = await requireUser();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const view = await loadThreadForUser(getSyncDeps(), user.id, id);
  if (!view) notFound();
  const db = getDb();
  const [insight, summary, draftRows, prefs, credential] = await Promise.all([
    getThreadInsight(db, view.id),
    getSummary(db, view.id),
    listDraftsForThread(db, user.id, view.id),
    getWritingPreferences(db, user.id),
    getAiCredentialSummary(db, user.id),
  ]);
  await connection();
  const now = new Date();
  const encryptor = getEncryptor();
  const drafts: DraftView[] = await Promise.all(
    draftRows
      .filter((d) => d.status !== "discarded")
      .map(async (d) => {
        const status = d.status as DraftView["status"];
        // Pending drafts hold a placeholder and failed drafts may too: never decrypt them.
        let body: string | null = null;
        let unreadable = false;
        if (status !== "pending" && status !== "failed") {
          try {
            body = await encryptor.decryptString(d.bodyCiphertext, aad.replyDraft(d.id));
          } catch {
            unreadable = true;
          }
        }
        return {
          id: d.id,
          status,
          body,
          unreadable,
          stuck: status === "pending" && isOlderThan(d.createdAt, now, PENDING_STALE_MS),
          error: d.error,
          providerDraftId: d.providerDraftId,
          saving: d.saveRequestedAt !== null && !isOlderThan(d.saveRequestedAt, now, SAVE_STALE_MS),
          savedAt: d.savedAt,
        };
      }),
  );
  const summaryStuck =
    summary?.status === "pending" && isOlderThan(summary.requestedAt, now, PENDING_STALE_MS);
  const pending =
    (summary?.status === "pending" && !summaryStuck) ||
    drafts.some((d) => (d.status === "pending" && !d.stuck) || d.saving);
  return (
    <ThreadView
      view={view}
      insight={insight}
      summary={summary}
      summaryStuck={summaryStuck}
      drafts={drafts}
      defaultTone={prefs.defaultTone}
      hasValidKey={credential?.status === "valid"}
      pending={pending}
      now={now}
    />
  );
}

export default function ThreadPage({ params }: PageProps<"/thread/[id]">) {
  return (
    <Suspense fallback={<div className="mx-auto h-64 w-full max-w-3xl animate-pulse px-6 py-6" />}>
      <ThreadContent params={params} />
    </Suspense>
  );
}
