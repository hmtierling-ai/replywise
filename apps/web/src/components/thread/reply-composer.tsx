import { REPLY_TONE_META, REPLY_TONES, type ReplyTone } from "@replywise/core";
import Link from "next/link";
import {
  discardDraftAction,
  generateDraftAction,
  saveDraftEditAction,
  saveDraftToGmailAction,
} from "@/app/(app)/thread/[id]/actions";
import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import { generationError } from "@/lib/draft-messages";
import { formatThreadTime } from "@/lib/inbox-format";

/** Draft data safe for rendering: the body is already decrypted, never the ciphertext. */
export interface DraftView {
  id: string;
  status: "pending" | "generated" | "edited" | "saved" | "failed";
  /** Decrypted body; null for pending and failed drafts. */
  body: string | null;
  /** Decryption failed: show a discard-only message instead of the editor. */
  unreadable: boolean;
  /** Pending for longer than PENDING_STALE_MS. */
  stuck: boolean;
  error: string | null;
  providerDraftId: string | null;
  /** A save to Gmail is in flight (requested and not stale). */
  saving: boolean;
  savedAt: Date | null;
}

function GenerateForm({
  threadId,
  defaultTone,
  regenerate,
}: {
  threadId: string;
  defaultTone: ReplyTone;
  regenerate: boolean;
}) {
  return (
    <form action={generateDraftAction} className="flex flex-col gap-2">
      <input type="hidden" name="threadId" value={threadId} />
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="reply-tone" className="text-sm text-muted-foreground">
          Tone
        </label>
        <select
          id="reply-tone"
          name="tone"
          defaultValue={defaultTone}
          className="h-8 rounded-lg border border-border bg-background px-2 text-sm"
        >
          {REPLY_TONES.map((tone) => (
            <option key={tone} value={tone}>
              {REPLY_TONE_META[tone].label}
            </option>
          ))}
        </select>
      </div>
      <label htmlFor="reply-instructions" className="sr-only">
        Instructions (optional)
      </label>
      <textarea
        id="reply-instructions"
        name="instructions"
        maxLength={2000}
        rows={2}
        placeholder="Instructions (optional), e.g. suggest Thursday afternoon"
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
      />
      <div>
        <Button type="submit" size="sm">
          {regenerate ? "Regenerate" : "Generate reply"}
        </Button>
      </div>
    </form>
  );
}

function DiscardForm({ draftId, threadId }: { draftId: string; threadId: string }) {
  return (
    <form action={discardDraftAction}>
      <input type="hidden" name="draftId" value={draftId} />
      <input type="hidden" name="threadId" value={threadId} />
      <Button type="submit" size="sm" variant="ghost">
        Discard
      </Button>
    </form>
  );
}

function DraftItem({
  draft,
  threadId,
  mailboxEmail,
  now,
}: {
  draft: DraftView;
  threadId: string;
  mailboxEmail: string;
  now: Date;
}) {
  if (draft.status === "pending" && !draft.stuck) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="status" className="text-sm font-medium">
          Writing a reply…
        </p>
        <DiscardForm draftId={draft.id} threadId={threadId} />
      </div>
    );
  }
  if (draft.status === "pending" || draft.status === "failed" || draft.unreadable) {
    const message = draft.unreadable
      ? "This draft can't be read. Discard it and generate a new one."
      : draft.status === "pending"
        ? "Writing this reply took too long."
        : generationError(draft.error ?? "internal");
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
        <DiscardForm draftId={draft.id} threadId={threadId} />
      </div>
    );
  }
  return (
    <form className="flex flex-col gap-2">
      <input type="hidden" name="draftId" value={draft.id} />
      <input type="hidden" name="threadId" value={threadId} />
      <label htmlFor={`draft-body-${draft.id}`} className="sr-only">
        Reply draft
      </label>
      <textarea
        id={`draft-body-${draft.id}`}
        name="body"
        defaultValue={draft.body ?? ""}
        rows={10}
        maxLength={20000}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={draft.saving}
          formAction={saveDraftEditAction}
        >
          Save edits
        </Button>
        <Button type="submit" size="sm" disabled={draft.saving} formAction={saveDraftToGmailAction}>
          {draft.providerDraftId ? "Update Gmail draft" : "Save to Gmail"}
        </Button>
        <Button
          type="submit"
          size="sm"
          variant="ghost"
          disabled={draft.saving}
          formAction={discardDraftAction}
        >
          Discard
        </Button>
      </div>
      {draft.error ? (
        <p role="alert" className="text-sm text-destructive">
          {generationError(draft.error ?? "internal")}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Your signature is added when saving. Replywise never sends email — open the draft in Gmail
        to review and send it yourself.
      </p>
      <p className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
        {draft.saving ? (
          <span role="status">Saving to Gmail…</span>
        ) : draft.savedAt ? (
          <span>
            Saved to Gmail{" "}
            <LocalTime
              iso={draft.savedAt.toISOString()}
              serverText={formatThreadTime(draft.savedAt, now)}
            />
          </span>
        ) : null}
        <a
          href={`https://mail.google.com/mail/u/?authuser=${encodeURIComponent(mailboxEmail)}#drafts`}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-4"
        >
          Open Gmail drafts
        </a>
      </p>
    </form>
  );
}

export function ReplyComposer({
  threadId,
  drafts,
  defaultTone,
  hasValidKey,
  mailboxEmail,
  now,
}: {
  threadId: string;
  /** Newest first. */
  drafts: DraftView[];
  defaultTone: ReplyTone;
  hasValidKey: boolean;
  mailboxEmail: string;
  now: Date;
}) {
  return (
    <section aria-label="Reply" className="mt-6 rounded-lg border border-border px-4 py-3">
      <h2 className="mb-2 text-sm font-semibold">Reply</h2>
      {hasValidKey ? (
        <GenerateForm
          threadId={threadId}
          defaultTone={defaultTone}
          regenerate={drafts.length > 0}
        />
      ) : (
        <Link href="/settings/ai" className="text-sm underline underline-offset-4">
          Add your Anthropic key to write replies
        </Link>
      )}
      {drafts.length > 0 ? (
        <ol className="mt-4 flex flex-col gap-3">
          {drafts.map((draft, index) => (
            <li key={draft.id}>
              <details open={index === 0} className="group">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  {index === 0 ? "Latest draft" : "Earlier draft"}
                </summary>
                <div className="mt-2">
                  <DraftItem
                    draft={draft}
                    threadId={threadId}
                    mailboxEmail={mailboxEmail}
                    now={now}
                  />
                </div>
              </details>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
