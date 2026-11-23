import { getAiCredentialSummary } from "@replywise/db";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

/** Reads the session and DB; render inside <Suspense>. */
export async function AiStatusBanner() {
  const user = await requireUser();
  const credential = await getAiCredentialSummary(getDb(), user.id);
  if (credential?.status === "valid") return null;
  const rejected = credential?.status === "invalid";
  return (
    <p
      role="status"
      className="mx-4 mt-4 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm sm:mx-6"
    >
      {rejected
        ? "Anthropic rejected your API key, so classification is paused. "
        : "Add your Anthropic API key to sort mail into Urgent, Important, Needs Reply, Informational and Low Priority. "}
      <Link href="/settings/ai" className="font-medium underline underline-offset-4">
        {rejected ? "Update key" : "Add key"}
      </Link>
    </p>
  );
}
