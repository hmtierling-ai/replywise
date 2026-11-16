import { MAIL_PROVIDERS, type MailProviderId } from "@replywise/core";
import { connectMailboxAction } from "@/app/(app)/settings/mailboxes/actions";
import { Button } from "@/components/ui/button";
import { PROVIDER_LABEL } from "@/lib/mailbox-messages";

export function ConnectButtons({ configured }: { configured: MailProviderId[] }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      {MAIL_PROVIDERS.map((provider) => {
        const enabled = configured.includes(provider);
        return (
          <form key={provider} action={connectMailboxAction}>
            <input type="hidden" name="provider" value={provider} />
            <Button
              type="submit"
              variant="outline"
              disabled={!enabled}
              title={
                enabled ? undefined : `${PROVIDER_LABEL[provider]} is not configured on this server`
              }
              className="w-full sm:w-auto"
            >
              Connect {PROVIDER_LABEL[provider]}
            </Button>
          </form>
        );
      })}
    </div>
  );
}
