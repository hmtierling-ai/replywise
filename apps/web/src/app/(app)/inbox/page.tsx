import Link from "next/link";
import { EmptyInbox } from "@/components/inbox/empty-inbox";
import { Button } from "@/components/ui/button";

export const metadata = { title: "All mail" };

export default function InboxPage() {
  return (
    <EmptyInbox
      title="No mailboxes connected"
      description="Connect Gmail or Outlook and Replywise will sort new mail into Urgent, Important, Needs Reply, Informational and Low Priority."
      action={
        <Button asChild size="sm">
          <Link href="/settings/mailboxes">Connect a mailbox</Link>
        </Button>
      }
    />
  );
}
