"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { scheduleSendAction } from "@/app/(app)/thread/[id]/send-actions";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { normalizeBody } from "@/lib/draft-body";
import { sendActionError } from "@/lib/draft-messages";

const PREVIEW_CHARS = 300;

/** "Send…" plus the confirmation dialog (spec M6 §2.2 step 1). */
export function SendControls({
  draftId,
  savedBody,
  to,
  subject,
  label = "Send…",
  disabled = false,
}: {
  draftId: string;
  /** The stored (decrypted) body: what will be sent and what the action re-checks. */
  savedBody: string;
  to: string;
  subject: string;
  label?: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onOpenChange(next: boolean) {
    if (next) {
      // The editor is the draft's textarea; unsaved edits must be saved before sending. Same
      // normalization as the server, so "unsaved" means what saving would actually change.
      const field = document.getElementById(`draft-body-${draftId}`);
      const current = field instanceof HTMLTextAreaElement ? normalizeBody(field.value) : savedBody;
      setDirty(current !== savedBody);
      setError(null);
    }
    setOpen(next);
  }

  const preview =
    savedBody.length > PREVIEW_CHARS ? `${savedBody.slice(0, PREVIEW_CHARS)}…` : savedBody;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogTrigger asChild>
        <Button type="button" size="sm" disabled={disabled}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Send this reply?</AlertDialogTitle>
          <AlertDialogDescription>
            Replywise sends it from your Gmail account after a 10-second chance to undo. Your
            signature is added at the end.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {dirty ? (
          <p role="alert" className="text-sm text-destructive">
            You have unsaved edits. Click "Save edits" first, then send.
          </p>
        ) : (
          <div className="flex flex-col gap-2 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">To</dt>
              <dd className="break-all">{to}</dd>
              <dt className="text-muted-foreground">Subject</dt>
              <dd>{subject}</dd>
            </dl>
            <p className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 px-3 py-2">
              {preview}
            </p>
          </div>
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
          {dirty ? null : (
            <Button
              type="button"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await scheduleSendAction({ draftId, expectedBody: savedBody });
                  if (result.ok) {
                    setOpen(false);
                    router.refresh();
                  } else {
                    setError(sendActionError(result.error));
                  }
                })
              }
            >
              {pending ? "Sending…" : "Send now"}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
