import { isOtherTab } from "@replywise/db";
import { Suspense } from "react";
import { OtherTabs } from "@/components/inbox/other-tabs";
import { SearchBox } from "@/components/inbox/search-box";
import { ThreadList, ThreadListSkeleton } from "@/components/inbox/thread-list";

export const metadata = { title: "Other" };

async function OtherContent({
  searchParams,
}: {
  searchParams: PageProps<"/other">["searchParams"];
}) {
  const raw = (await searchParams).tab;
  const tab = typeof raw === "string" && isOtherTab(raw) ? raw : null;
  return (
    <>
      <OtherTabs active={tab} />
      <ThreadList view={{ kind: "other", tab }} />
    </>
  );
}

export default function OtherPage({ searchParams }: PageProps<"/other">) {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <h1 className="sr-only">Other</h1>
      <SearchBox />
      <Suspense fallback={<ThreadListSkeleton />}>
        <OtherContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
