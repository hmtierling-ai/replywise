import { listMailAccounts, SEARCH_MAX_CHARS, SEARCH_MIN_CHARS, searchThreads } from "@replywise/db";
import { connection } from "next/server";
import { Suspense } from "react";
import { EmptyInbox } from "@/components/inbox/empty-inbox";
import { SearchBox } from "@/components/inbox/search-box";
import { ThreadListSkeleton, ThreadRows } from "@/components/inbox/thread-list";
import { GmailSearch } from "@/components/search/gmail-search";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const metadata = { title: "Search" };

async function SearchContent({
  searchParams,
}: {
  searchParams: PageProps<"/search">["searchParams"];
}) {
  const user = await requireUser();
  const raw = (await searchParams).q;
  const q = (typeof raw === "string" ? raw : "").trim().slice(0, SEARCH_MAX_CHARS);
  await connection();
  const db = getDb();
  const [mailboxes, results] = await Promise.all([
    listMailAccounts(db, user.id),
    searchThreads(db, user.id, q),
  ]);
  const gmail = mailboxes
    .filter((m) => m.provider === "gmail")
    .map((m) => ({ id: m.id, emailAddress: m.emailAddress }));
  const searchable = q.length >= SEARCH_MIN_CHARS;
  return (
    <>
      <SearchBox defaultValue={q} />
      {!searchable ? (
        <p className="px-4 py-4 text-sm text-muted-foreground sm:px-6">
          Type at least 2 characters to search subjects, senders and previews.
        </p>
      ) : results.length === 0 ? (
        <EmptyInbox
          title="No matches in Replywise"
          description="Replywise searches subjects, senders and previews of synced mail. Try searching all of Gmail below."
        />
      ) : (
        <ThreadRows
          threads={results}
          ownEmails={mailboxes.map((m) => m.emailAddress)}
          now={new Date()}
        />
      )}
      {searchable && gmail.length > 0 ? <GmailSearch key={q} q={q} mailboxes={gmail} /> : null}
    </>
  );
}

export default function SearchPage({ searchParams }: PageProps<"/search">) {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <h1 className="sr-only">Search</h1>
      <Suspense fallback={<ThreadListSkeleton />}>
        <SearchContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
