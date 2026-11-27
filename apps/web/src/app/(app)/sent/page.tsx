import { Suspense } from "react";
import { SearchBox } from "@/components/inbox/search-box";
import { ThreadList, ThreadListSkeleton } from "@/components/inbox/thread-list";

export const metadata = { title: "Sent" };

export default function SentPage() {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <h1 className="sr-only">Sent</h1>
      <SearchBox />
      <Suspense fallback={<ThreadListSkeleton />}>
        <ThreadList view={{ kind: "sent" }} />
      </Suspense>
    </div>
  );
}
