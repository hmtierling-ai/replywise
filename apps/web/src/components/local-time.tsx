"use client";

import { useEffect, useState } from "react";
import { formatThreadTime } from "@/lib/inbox-format";

/**
 * Renders the server-formatted text first so SSR and hydration match, then re-formats in the
 * browser's own timezone.
 */
export function LocalTime({
  iso,
  serverText,
  className,
}: {
  iso: string;
  serverText: string;
  className?: string;
}) {
  const [text, setText] = useState(serverText);
  useEffect(() => {
    setText(formatThreadTime(new Date(iso), new Date()));
  }, [iso]);
  return (
    <time dateTime={iso} className={className}>
      {text}
    </time>
  );
}
