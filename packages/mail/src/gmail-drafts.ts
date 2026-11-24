import { ProviderHttpError, requestJson } from "./http";
import type { FetchLike } from "./types";

const DRAFTS = "https://gmail.googleapis.com/gmail/v1/users/me/drafts";

/** Write access limited to drafts.create / drafts.update. Deliberately has no delivery capability. */
export interface GmailDraftsApi {
  createDraft(input: { raw: string; threadId: string }): Promise<{ draftId: string }>;
  /** null when the draft no longer exists in Gmail (deleted or already handled by the user). */
  updateDraft(
    draftId: string,
    input: { raw: string; threadId: string },
  ): Promise<{ draftId: string } | null>;
}

export type GmailDraftsFactory = (accessToken: string) => GmailDraftsApi;

function draftIdOf(body: Record<string, unknown>, path: string): string {
  if (typeof body.id !== "string" || body.id === "") throw new ProviderHttpError(200, path);
  return body.id;
}

export function createGmailDraftsApi(
  accessToken: string,
  options: { fetch?: FetchLike } = {},
): GmailDraftsApi {
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  return {
    async createDraft({ raw, threadId }) {
      const body = await requestJson(fetchImpl, "POST", DRAFTS, accessToken, {
        message: { raw, threadId },
      });
      return { draftId: draftIdOf(body, "/gmail/v1/users/me/drafts") };
    },
    async updateDraft(draftId, { raw, threadId }) {
      const url = `${DRAFTS}/${encodeURIComponent(draftId)}`;
      try {
        const body = await requestJson(fetchImpl, "PUT", url, accessToken, {
          id: draftId,
          message: { raw, threadId },
        });
        return { draftId: draftIdOf(body, "/gmail/v1/users/me/drafts/{id}") };
      } catch (error) {
        if (error instanceof ProviderHttpError && error.status === 404) return null;
        throw error;
      }
    },
  };
}
