"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { undoSendAction } from "@/app/(app)/thread/[id]/send-actions";
import { Button } from "@/components/ui/button";
import { sendActionError } from "@/lib/draft-messages";

/** "Sending in N s… Undo" during the 10-second undo window. */
export function SendCountdown({ draftId, sendAt }: { draftId: string; sendAt: string }) {
  const router = useRouter();
  const target = new Date(sendAt).getTime();
  // null until mounted: the server cannot know the client's clock (no hydration mismatch).
  const [left, setLeft] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Math.ceil((target - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [target]);
  const text =
    left === null ? "Sending in a few seconds…" : left > 0 ? `Sending in ${left} s…` : "Sending…";
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p role="status" className="text-sm font-medium">
        {text}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await undoSendAction({ draftId });
            if (result.ok) router.refresh();
            else setError(sendActionError(result.error));
          })
        }
      >
        Undo
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
