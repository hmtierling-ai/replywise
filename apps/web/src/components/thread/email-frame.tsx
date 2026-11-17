"use client";

import { useCallback, useRef } from "react";

/**
 * Renders sanitized email HTML in a sandboxed iframe: no scripts (no allow-scripts), links may
 * open new tabs. allow-same-origin lets the parent measure the content height; without
 * allow-scripts the frame still cannot run code.
 */
export function EmailFrame({ srcDoc }: { srcDoc: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const resize = useCallback(() => {
    const doc = ref.current?.contentDocument;
    if (ref.current && doc) ref.current.style.height = `${doc.documentElement.scrollHeight + 4}px`;
  }, []);
  return (
    <iframe
      ref={ref}
      title="Email content"
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      onLoad={resize}
      className="h-40 w-full rounded-md border border-border bg-white"
    />
  );
}
