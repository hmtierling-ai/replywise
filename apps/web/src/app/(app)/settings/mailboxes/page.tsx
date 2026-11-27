import Link from "next/link";
import { Suspense } from "react";
import { MailboxFlash } from "@/components/mailboxes/flash";
import { MailboxList, MailboxListSkeleton } from "@/components/mailboxes/mailbox-list";

export const metadata = { title: "Mailboxes" };

export default function MailboxesPage({ searchParams }: PageProps<"/settings/mailboxes">) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
      <Link href="/settings" className="text-sm text-muted-foreground hover:text-foreground">
        ← Settings
      </Link>
      <h1 className="mt-3 text-xl font-semibold tracking-tight">Mailboxes</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Connect Gmail or Outlook. Replywise reads your mail and saves reply drafts to your mailbox —
        it never sends email without your confirmation.
      </p>
      <Suspense fallback={null}>
        <MailboxFlash searchParams={searchParams} />
      </Suspense>
      <Suspense fallback={<MailboxListSkeleton />}>
        <MailboxList />
      </Suspense>
    </div>
  );
}
