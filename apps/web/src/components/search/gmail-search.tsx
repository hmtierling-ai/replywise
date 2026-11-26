"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import {
  type GmailSearchHit,
  importGmailThreadAction,
  searchGmailAction,
} from "@/app/(app)/search/actions";
import { Button } from "@/components/ui/button";
import { GMAIL_SEARCH_ERRORS } from "@/lib/search-messages";

interface Mailbox {
  id: string;
  emailAddress: string;
}

/** "Search all of Gmail": one button per connected Gmail mailbox (spec M6 §5.2). */
export function GmailSearch({ q, mailboxes }: { q: string; mailboxes: Mailbox[] }) {
  return (
    <section
      aria-label="Search all of Gmail"
      className="flex flex-col gap-4 border-t border-border px-4 py-4 sm:px-6"
    >
      {mailboxes.map((mailbox) => (
        <MailboxSearch key={mailbox.id} q={q} mailbox={mailbox} showEmail={mailboxes.length > 1} />
      ))}
    </section>
  );
}

function MailboxSearch({
  q,
  mailbox,
  showEmail,
}: {
  q: string;
  mailbox: Mailbox;
  showEmail: boolean;
}) {
  const [hits, setHits] = useState<GmailSearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const search = () =>
    startTransition(async () => {
      setError(null);
      const result = await searchGmailAction({ mailAccountId: mailbox.id, q });
      if (result.ok) {
        setHits(result.hits);
      } else {
        setHits(null);
        setError(GMAIL_SEARCH_ERRORS[result.error]);
      }
    });

  const importHit = (hit: GmailSearchHit) =>
    startTransition(async () => {
      setError(null);
      // Success redirects to the imported thread; only failures come back.
      const result = await importGmailThreadAction({
        mailAccountId: mailbox.id,
        providerThreadId: hit.providerThreadId,
      });
      setError(GMAIL_SEARCH_ERRORS[result.error]);
    });

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={search}>
          {showEmail ? `Search all of Gmail (${mailbox.emailAddress})` : "Search all of Gmail"}
        </Button>
      </div>
      {pending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Working with Gmail…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {hits !== null && hits.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Gmail results.</p>
      ) : null}
      {hits && hits.length > 0 ? (
        <ul
          aria-label="Gmail results"
          className="divide-y divide-border rounded-lg border border-border"
        >
          {hits.map((hit) => (
            <li
              key={hit.providerThreadId}
              className="flex items-start justify-between gap-3 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{hit.subject || "(no subject)"}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {hit.from} · {new Date(hit.date).toLocaleDateString()}
                </p>
                <p className="truncate text-sm text-muted-foreground">{hit.snippet}</p>
              </div>
              {hit.localThreadId ? (
                <Button asChild size="sm" variant="ghost">
                  <Link href={`/thread/${hit.localThreadId}`}>Open</Link>
                </Button>
              ) : (
                <Button type="button" size="sm" disabled={pending} onClick={() => importHit(hit)}>
                  Import
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
