export const MAIL_PROVIDERS = ["gmail", "outlook"] as const;
export type MailProviderId = (typeof MAIL_PROVIDERS)[number];

export interface EmailAddress {
  name: string | null;
  address: string;
}
