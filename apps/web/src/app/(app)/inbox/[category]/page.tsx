import { CATEGORY_META, categoryFromSlug, INBOX_CATEGORIES } from "@replywise/core";
import { notFound } from "next/navigation";
import { EmptyInbox } from "@/components/inbox/empty-inbox";

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
  const meta = CATEGORY_META[category];
  return <EmptyInbox title={`Nothing in ${meta.label}`} description={meta.description} />;
}
