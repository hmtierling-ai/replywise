import Link from "next/link";
import { Suspense } from "react";
import { AiSettings, AiSettingsSkeleton } from "@/components/settings/ai-settings";
import { AI_ERROR_MESSAGES, AI_SUCCESS_MESSAGES } from "@/lib/ai-messages";

export const metadata = { title: "AI" };

async function Flash({
  searchParams,
}: {
  searchParams: PageProps<"/settings/ai">["searchParams"];
}) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? AI_ERROR_MESSAGES[params.error] : undefined;
  const saved = typeof params.saved === "string" ? AI_SUCCESS_MESSAGES[params.saved] : undefined;
  if (error) {
    return (
      <p
        role="alert"
        className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
      >
        {error}
      </p>
    );
  }
  if (saved) {
    return (
      <p
        role="status"
        className="mt-6 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm"
      >
        {saved}
      </p>
    );
  }
  return null;
}

export default function AiSettingsPage({ searchParams }: PageProps<"/settings/ai">) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
      <Link href="/settings" className="text-sm text-muted-foreground hover:text-foreground">
        ← Settings
      </Link>
      <h1 className="mt-3 text-xl font-semibold tracking-tight">AI</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Replywise classifies your mail with your own Anthropic key. It never sends email without
        your confirmation.
      </p>
      <Suspense fallback={null}>
        <Flash searchParams={searchParams} />
      </Suspense>
      <Suspense fallback={<AiSettingsSkeleton />}>
        <AiSettings />
      </Suspense>
    </div>
  );
}
