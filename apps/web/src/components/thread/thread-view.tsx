import type { ThreadInsight } from "@replywise/db";
import type { ThreadView as ThreadViewData } from "@replywise/sync";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { InsightPanel } from "@/components/thread/insight-panel";
import { buildEmailDocument, gmailThreadUrl, sanitizeEmailHtml } from "@/lib/email-html";
import { formatThreadTime } from "@/lib/inbox-format";
import { EmailFrame } from "./email-frame";

const name = (a: { name: string | null; address: string }) => a.name ?? a.address;

export function ThreadView({
  view,
  insight,
  now,
}: {
  view: ThreadViewData;
  insight: ThreadInsight | null;
  now: Date;
}) {
  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <Link href="/inbox" className="text-sm text-muted-foreground hover:text-foreground">
        ← All mail
      </Link>
      <header className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{view.subject || "(no subject)"}</h1>
        {view.mailbox.provider === "gmail" ? (
          <a
            href={gmailThreadUrl(view.mailbox.emailAddress, view.providerThreadId)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            Open in Gmail <ExternalLink className="size-3.5" aria-hidden />
          </a>
        ) : null}
      </header>
      {insight ? <InsightPanel insight={insight} /> : null}
      {view.bodiesUnavailable ? (
        <p
          role="status"
          className="mt-4 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm"
        >
          Some message bodies could not be loaded right now. Showing previews instead.
        </p>
      ) : null}
      <ol className="mt-6 flex flex-col gap-4">
        {view.messages.map((message) => (
          <li key={message.id} className="rounded-lg border border-border">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
              <p className="text-sm">
                <span className="font-medium">
                  {message.isFromUser ? "You" : name(message.from)}
                </span>{" "}
                <span className="text-muted-foreground">
                  to {message.to.map(name).join(", ") || "(no recipients)"}
                </span>
              </p>
              <LocalTime
                iso={message.sentAt.toISOString()}
                serverText={formatThreadTime(message.sentAt, now)}
                className="text-xs text-muted-foreground"
              />
            </div>
            <div className="p-3">
              {message.body?.html ? (
                <EmailFrame srcDoc={buildEmailDocument(sanitizeEmailHtml(message.body.html))} />
              ) : (
                <p className="whitespace-pre-wrap px-1 text-sm">
                  {message.body?.text || message.snippet || "(no content)"}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </article>
  );
}
