import { CATEGORY_META, categoryFromSlug, INBOX_CATEGORIES } from "@replywise/core";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AiStatusBanner } from "@/components/inbox/ai-status-banner";
import { ThreadList, ThreadListSkeleton } from "@/components/inbox/thread-list";

export function generateStaticParams() {
  return INBOX_CATEGORIES.map((category) => ({ category: CATEGORY_META[category].slug }));
}

export async function generateMetadata({ params }: PageProps<"/inbox/[category]">) {
  const category = categoryFromSlug((await params).category);
  return { title: category ? CATEGORY_META[category].label : "Not found" };
}

export default async function CategoryPage({ params }: PageProps<"/inbox/[category]">) {
  const category = categoryFromSlug((await params).category);
  if (!category) notFound();
  return (
    <div className="mx-auto w-full max-w-4xl">
      <h1 className="sr-only">{CATEGORY_META[category].label}</h1>
      <Suspense fallback={null}>
        <AiStatusBanner />
      </Suspense>
      <Suspense fallback={<ThreadListSkeleton />}>
        <ThreadList category={category} />
      </Suspense>
    </div>
  );
}
