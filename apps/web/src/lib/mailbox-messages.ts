import { isMailProviderId, type MailProviderId } from "@replywise/core";

export const PROVIDER_LABEL: Record<MailProviderId, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
};

export type Flash = { tone: "success" | "error" | "info"; message: string };

const ERROR_MESSAGES: Record<string, string> = {
  not_configured:
    "This provider isn't set up yet. Add its OAuth client ID and secret to the server configuration.",
  invalid_state: "That connection link was invalid or already used. Please try connecting again.",
  expired_state: "The connection took too long and expired. Please try again.",
  provider_mismatch:
    "The connection response didn't match the provider you chose. Please try again.",
  access_denied: "You declined access, so nothing was connected.",
  missing_scopes:
    "Replywise needs permission to read mail and create drafts. Please try again and allow all requested permissions.",
  provider_error: "The provider returned an error. Please try again in a moment.",
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function flashFromSearchParams(
  params: Record<string, string | string[] | undefined>,
): Flash | null {
  const error = first(params.error);
  if (error) {
    return {
      tone: "error",
      message: ERROR_MESSAGES[error] ?? "Something went wrong while connecting. Please try again.",
    };
  }
  const connected = first(params.connected);
  if (connected && isMailProviderId(connected)) {
    return {
      tone: "success",
      message: `${PROVIDER_LABEL[connected]} connected. Replywise can now read your mail and save drafts — it never sends email.`,
    };
  }
  const disconnected = first(params.disconnected);
  if (disconnected && isMailProviderId(disconnected)) {
    if (first(params.manual) === "1") {
      return {
        tone: "info",
        message: `${PROVIDER_LABEL[disconnected]} disconnected and its data deleted. To also remove Replywise's access, visit account.microsoft.com → Privacy → Apps and services.`,
      };
    }
    return {
      tone: "success",
      message: `${PROVIDER_LABEL[disconnected]} disconnected. Access was revoked and its data deleted.`,
    };
  }
  return null;
}
