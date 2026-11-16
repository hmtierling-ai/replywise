import type { MailProviderId } from "@replywise/core";
import { createGmailOAuth } from "./gmail";
import { createOutlookOAuth } from "./outlook";
import type { FetchLike, MailOAuthProvider } from "./types";

export type MailOAuthProviders = Partial<Record<MailProviderId, MailOAuthProvider>>;

interface ClientCredentials {
  clientId?: string | undefined;
  clientSecret?: string | undefined;
}

export interface MailOAuthConfig {
  gmail?: ClientCredentials;
  outlook?: ClientCredentials;
  fetch?: FetchLike;
}

function complete(
  c: ClientCredentials | undefined,
): { clientId: string; clientSecret: string } | null {
  return c?.clientId && c.clientSecret
    ? { clientId: c.clientId, clientSecret: c.clientSecret }
    : null;
}

/** Only providers with both a client id and a secret are enabled. */
export function createMailOAuthProviders(config: MailOAuthConfig): MailOAuthProviders {
  const providers: MailOAuthProviders = {};
  const fetchOption = config.fetch ? { fetch: config.fetch } : {};
  const gmail = complete(config.gmail);
  if (gmail) providers.gmail = createGmailOAuth({ ...gmail, ...fetchOption });
  const outlook = complete(config.outlook);
  if (outlook) providers.outlook = createOutlookOAuth({ ...outlook, ...fetchOption });
  return providers;
}
