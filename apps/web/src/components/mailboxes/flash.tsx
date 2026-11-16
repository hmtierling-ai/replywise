import { CircleAlert, CircleCheck, Info } from "lucide-react";
import { flashFromSearchParams } from "@/lib/mailbox-messages";
import { cn } from "@/lib/utils";

const ICON = { success: CircleCheck, error: CircleAlert, info: Info } as const;

/** Reads searchParams; render inside <Suspense>. */
export async function MailboxFlash({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const flash = flashFromSearchParams(await searchParams);
  if (!flash) return null;
  const Icon = ICON[flash.tone];
  return (
    <div
      role={flash.tone === "error" ? "alert" : "status"}
      className={cn(
        "mt-6 flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm",
        flash.tone === "error" && "border-destructive/40 bg-destructive/5 text-destructive",
        flash.tone === "success" && "border-border bg-muted/50",
        flash.tone === "info" && "border-border bg-muted/50",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>{flash.message}</p>
    </div>
  );
}
