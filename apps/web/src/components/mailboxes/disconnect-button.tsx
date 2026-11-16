"use client";

import { disconnectMailboxAction } from "@/app/(app)/settings/mailboxes/actions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

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
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {email}?</AlertDialogTitle>
          <AlertDialogDescription>
            Replywise will stop reading this mailbox and delete everything it stored for it. Drafts
            already saved in your mailbox stay there.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <form action={disconnectMailboxAction}>
            <input type="hidden" name="mailAccountId" value={mailAccountId} />
            <AlertDialogAction type="submit">Disconnect</AlertDialogAction>
          </form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
