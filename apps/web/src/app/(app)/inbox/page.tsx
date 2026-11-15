import { EmptyInbox } from "@/components/inbox/empty-inbox";

export const metadata = { title: "All mail" };

export default function InboxPage() {
  return (
    <EmptyInbox
      title="No mailboxes connected"
      description="Connect Gmail or Outlook and Replywise will sort new mail into Urgent, Important, Needs Reply, Informational and Low Priority."
    />
  );
}
