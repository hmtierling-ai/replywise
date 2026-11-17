import { Suspense } from "react";
import { ThreadList, ThreadListSkeleton } from "@/components/inbox/thread-list";

export const metadata = { title: "All mail" };

export default function InboxPage() {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <h1 className="sr-only">All mail</h1>
      <Suspense fallback={<ThreadListSkeleton />}>
        <ThreadList />
      </Suspense>
    </div>
  );
}
