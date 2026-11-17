"use client";

import { useFormStatus } from "react-dom";
import { disconnectMailboxAction } from "@/app/(app)/settings/mailboxes/actions";
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

function ConfirmDisconnectButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="destructive" disabled={pending}>
      {pending ? "Disconnecting…" : "Disconnect"}
    </Button>
  );
}

export function DisconnectButton({
  mailAccountId,
  email,
}: {
  mailAccountId: string;
  email: string;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={`Disconnect ${email}`}>
          Disconnect
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        {/* A plain submit button (not AlertDialogAction): Radix's Action closes the dialog on
            click, which can unmount the form before the Server Action is submitted. */}
        <form action={disconnectMailboxAction} className="contents">
          <input type="hidden" name="mailAccountId" value={mailAccountId} />
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {email}?</AlertDialogTitle>
            <AlertDialogDescription>
              Replywise will stop reading this mailbox and delete everything it stored for it.
              Drafts already saved in your mailbox stay there.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
            <ConfirmDisconnectButton />
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
