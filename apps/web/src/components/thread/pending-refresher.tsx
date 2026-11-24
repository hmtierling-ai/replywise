"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-renders the page every 2 s while AI or Gmail work is pending; stops after 3 minutes. */
export function PendingRefresher({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > 180_000) clearInterval(timer);
      else router.refresh();
    }, 2_000);
    return () => clearInterval(timer);
  }, [active, router]);
  return null;
}
