import { listMailAccounts, type MailAccountSummary } from "@replywise/db";
import { Mail } from "lucide-react";
import { connectMailboxAction } from "@/app/(app)/settings/mailboxes/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { configuredMailProviders } from "@/lib/mailbox";
import { PROVIDER_LABEL } from "@/lib/mailbox-messages";
import { ConnectButtons } from "./connect-buttons";
import { DisconnectButton } from "./disconnect-button";

const STATUS: Record<
  MailAccountSummary["status"],
  { label: string; variant: "secondary" | "destructive" }
> = {
  active: { label: "Connected", variant: "secondary" },
  needs_reauth: { label: "Reconnect needed", variant: "destructive" },
  error: { label: "Error", variant: "destructive" },
};

/** Reads the session and DB; render inside <Suspense>. */
export async function MailboxList() {
  const user = await requireUser();
  const accounts = await listMailAccounts(getDb(), user.id);
  const configured = configuredMailProviders();

  return (
    <div className="mt-8 flex flex-col gap-6">
      {accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No mailboxes connected yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {accounts.map((account) => {
            const status = STATUS[account.status];
            return (
              <li key={account.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Mail className="size-4 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{account.emailAddress}</p>
                  <p className="text-xs text-muted-foreground">
                    {PROVIDER_LABEL[account.provider]}
                  </p>
                </div>
                <Badge variant={status.variant}>{status.label}</Badge>
                {account.status !== "active" && configured.includes(account.provider) ? (
                  <form action={connectMailboxAction}>
                    <input type="hidden" name="provider" value={account.provider} />
                    <input type="hidden" name="loginHint" value={account.emailAddress} />
                    <Button type="submit" size="sm">
                      Reconnect
                    </Button>
                  </form>
                ) : null}
                <DisconnectButton mailAccountId={account.id} email={account.emailAddress} />
              </li>
            );
          })}
        </ul>
      )}
      <ConnectButtons configured={configured} />
    </div>
  );
}

export function MailboxListSkeleton() {
  return (
    <div className="mt-8 flex flex-col gap-3" aria-hidden>
      <div className="h-14 animate-pulse rounded-lg bg-muted" />
      <div className="h-9 w-40 animate-pulse rounded-md bg-muted" />
    </div>
  );
}
