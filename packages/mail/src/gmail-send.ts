import { ProviderHttpError, requestJson } from "./http";
import type { FetchLike } from "./types";

const SEND_DRAFT_URL = "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send";
const SEND_DRAFT_PATH = "/gmail/v1/users/me/drafts/send";

/**
 * The ONLY code in Replywise that can deliver mail (spec M6 §2.3): it sends a Gmail draft the user
 * confirmed. One call, no retries here; the worker's send job owns every retry decision. The
 * no-send guard test enforces that the worker send job is its only importer.
 */
export interface GmailSendApi {
  sendDraft(providerDraftId: string): Promise<{ messageId: string; threadId: string | null }>;
}

export type GmailSendFactory = (accessToken: string) => GmailSendApi;

export function createGmailSendApi(
  accessToken: string,
  options: { fetch?: FetchLike } = {},
): GmailSendApi {
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  return {
    async sendDraft(providerDraftId) {
      const body = await requestJson(fetchImpl, "POST", SEND_DRAFT_URL, accessToken, {
        id: providerDraftId,
      });
      if (typeof body.id !== "string" || body.id === "") {
        throw new ProviderHttpError(200, SEND_DRAFT_PATH);
      }
      return {
        messageId: body.id,
        threadId: typeof body.threadId === "string" ? body.threadId : null,
      };
    },
  };
}
