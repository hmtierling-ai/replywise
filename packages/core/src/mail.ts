export const MAIL_PROVIDERS = ["gmail", "outlook"] as const;
export type MailProviderId = (typeof MAIL_PROVIDERS)[number];

export function isMailProviderId(value: string): value is MailProviderId {
  return (MAIL_PROVIDERS as readonly string[]).includes(value);
}

export interface EmailAddress {
  name: string | null;
  address: string;
}
