import { getJson, ProviderHttpError } from "./http";
import {
  type GmailMessageResource,
  type ParsedThread,
  parseGmailMessage,
} from "./mime/gmail-message";
import type { FetchLike } from "./types";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const HISTORY_TYPES = ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"] as const;

/** Gmail no longer has history for the stored startHistoryId (HTTP 404): re-backfill. */
export class HistoryExpiredError extends Error {
  constructor() {
    super("Gmail history expired");
    this.name = "HistoryExpiredError";
  }
}

export interface HistoryPage {
  changedThreadIds: string[];
  deletedMessageIds: string[];
  historyId: string;
  nextPageToken: string | null;
}

/** Read-only Gmail access used by sync. Deliberately has no send or modify capability. */
export interface GmailApi {
  getProfile(): Promise<{ emailAddress: string; historyId: string }>;
  listThreadIds(input: {
    query: string;
    maxResults: number;
    pageToken?: string;
  }): Promise<{ ids: string[]; nextPageToken: string | null }>;
  getThread(threadId: string): Promise<ParsedThread | null>;
  listHistory(input: { startHistoryId: string; pageToken?: string }): Promise<HistoryPage>;
}

export type GmailApiFactory = (accessToken: string) => GmailApi;

type Ref = { message?: { id?: unknown; threadId?: unknown } };

function refs(value: unknown): Ref[] {
  return Array.isArray(value) ? (value as Ref[]) : [];
}

export interface GmailApiOptions {
  fetch?: FetchLike;
  /** Quota budget spent per second, in GMAIL_COST units (default 90 ≈ 90% of 6000/min). */
  unitsPerSecond?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxRetries?: number;
}

/**
 * Per-call quota cost used for pacing. Measured against a real account
 * (totalQueryCostPerMinutePerUser = 6000): threads.get?format=full exhausted the budget after
 * ~51 calls, i.e. ~115 units each — far above the documented 10. Values are conservative.
 */
export const GMAIL_COST = { profile: 10, listThreads: 100, getThread: 120, listHistory: 20 };

const MAX_BACKOFF_MS = 60_000;

export function createGmailApi(accessToken: string, options: GmailApiOptions = {}): GmailApi {
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const unitsPerSecond = options.unitsPerSecond ?? 90;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());
  const maxRetries = options.maxRetries ?? 4;
  let nextFree = 0;

  async function reserve(cost: number): Promise<void> {
    // Bookkeeping is synchronous so concurrent callers get distinct slots.
    const start = Math.max(now(), nextFree);
    nextFree = start + (cost / unitsPerSecond) * 1000;
    const wait = start - now();
    if (wait > 0) await sleep(wait);
  }

  async function get(url: URL, cost: number): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      await reserve(cost);
      try {
        return await getJson(fetchImpl, url.toString(), accessToken);
      } catch (error) {
        if (!(error instanceof ProviderHttpError) || !error.rateLimited || attempt >= maxRetries) {
          throw error;
        }
        await sleep(Math.min(error.retryAfterMs ?? 2000 * 2 ** attempt, MAX_BACKOFF_MS));
      }
    }
  }

  return {
    async getProfile() {
      const body = await get(new URL(`${BASE}/profile`), GMAIL_COST.profile);
      if (typeof body.emailAddress !== "string" || body.historyId === undefined) {
        throw new ProviderHttpError(200, "/gmail/v1/users/me/profile");
      }
      return { emailAddress: body.emailAddress.toLowerCase(), historyId: String(body.historyId) };
    },

    async listThreadIds({ query, maxResults, pageToken }) {
      const url = new URL(`${BASE}/threads`);
      url.searchParams.set("q", query);
      url.searchParams.set("maxResults", String(maxResults));
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const body = await get(url, GMAIL_COST.listThreads);
      const threads = Array.isArray(body.threads) ? (body.threads as Array<{ id?: unknown }>) : [];
      return {
        ids: threads.map((t) => t.id).filter((id): id is string => typeof id === "string"),
        nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : null,
      };
    },

    async getThread(threadId) {
      const url = new URL(`${BASE}/threads/${encodeURIComponent(threadId)}`);
      url.searchParams.set("format", "full");
      let body: Record<string, unknown>;
      try {
        body = await get(url, GMAIL_COST.getThread);
      } catch (error) {
        if (error instanceof ProviderHttpError && error.status === 404) return null;
        throw error;
      }
      const messages = Array.isArray(body.messages)
        ? (body.messages as GmailMessageResource[])
        : [];
      return {
        providerThreadId: threadId,
        messages: messages
          .map(parseGmailMessage)
          .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime()),
      };
    },

    async listHistory({ startHistoryId, pageToken }) {
      const url = new URL(`${BASE}/history`);
      url.searchParams.set("startHistoryId", startHistoryId);
      for (const type of HISTORY_TYPES) url.searchParams.append("historyTypes", type);
      url.searchParams.set("maxResults", "500");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      let body: Record<string, unknown>;
      try {
        body = await get(url, GMAIL_COST.listHistory);
      } catch (error) {
        if (error instanceof ProviderHttpError && error.status === 404) {
          throw new HistoryExpiredError();
        }
        throw error;
      }
      const changed = new Set<string>();
      const deleted = new Set<string>();
      const history = Array.isArray(body.history)
        ? (body.history as Record<string, unknown>[])
        : [];
      for (const entry of history) {
        for (const key of ["messagesAdded", "labelsAdded", "labelsRemoved", "messagesDeleted"]) {
          for (const ref of refs(entry[key])) {
            if (typeof ref.message?.threadId === "string") changed.add(ref.message.threadId);
          }
        }
        for (const ref of refs(entry.messagesDeleted)) {
          if (typeof ref.message?.id === "string") deleted.add(ref.message.id);
        }
      }
      return {
        changedThreadIds: [...changed],
        deletedMessageIds: [...deleted],
        historyId: body.historyId === undefined ? startHistoryId : String(body.historyId),
        nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : null,
      };
    },
  };
}
