import { loadThreadForUser } from "@replywise/sync";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ThreadView } from "@/components/thread/thread-view";
import { requireUser } from "@/lib/auth";
import { getSyncDeps } from "@/lib/sync";

export const metadata = { title: "Thread" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ThreadContent({ params }: { params: PageProps<"/thread/[id]">["params"] }) {
  const user = await requireUser();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const view = await loadThreadForUser(getSyncDeps(), user.id, id);
  if (!view) notFound();
  await connection();
  return <ThreadView view={view} now={new Date()} />;
}

export default function ThreadPage({ params }: PageProps<"/thread/[id]">) {
  return (
    <Suspense fallback={<div className="mx-auto h-64 w-full max-w-3xl animate-pulse px-6 py-6" />}>
      <ThreadContent params={params} />
    </Suspense>
  );
}
