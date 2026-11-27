import { Suspense } from "react";
import { AiStatusBanner } from "@/components/inbox/ai-status-banner";
import { SearchBox } from "@/components/inbox/search-box";
import { ThreadList, ThreadListSkeleton } from "@/components/inbox/thread-list";

export const metadata = { title: "All mail" };

export default function InboxPage() {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <h1 className="sr-only">All mail</h1>
      <SearchBox />
      <Suspense fallback={null}>
        <AiStatusBanner />
      </Suspense>
      <Suspense fallback={<ThreadListSkeleton />}>
        <ThreadList view={{ kind: "inbox" }} />
      </Suspense>
    </div>
  );
}
