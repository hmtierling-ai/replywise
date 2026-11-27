import type { GmailApi, GmailApiFactory, HistoryPage, ParsedMessage } from "@replywise/mail";
import { HistoryExpiredError } from "@replywise/mail";

let counter = 0;

export function fakeMessage(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  counter += 1;
  return {
    providerMessageId: `msg-${counter}`,
    providerThreadId: "t1",
    internetMessageId: null,
    from: { name: "Sender", address: "sender@example.com" },
    to: [{ name: null, address: "me@gmail.com" }],
    cc: [],
    subject: "Subject",
    snippet: "Snippet",
    sentAt: new Date("2026-11-15T00:00:00Z"),
    labelIds: ["INBOX"],
    hasAttachments: false,
    bodyText: "Body",
    bodyHtml: null,
    ...overrides,
  };
}

export interface FakeGmailSeed {
  historyId?: string;
  threads?: Record<string, ParsedMessage[]>;
  pageSize?: number;
  historyExpired?: boolean;
  failWith?: Error;
  /** Runs before each getThread (1-based call number); throw to fail that call. */
  onGetThread?: (threadId: string, call: number) => void;
}

/** In-memory Gmail double. Mutate `threads` / push to `history` between syncs. */
export function createFakeGmail(seed: FakeGmailSeed = {}) {
  const threads: Record<string, ParsedMessage[]> = { ...(seed.threads ?? {}) };
  const history: HistoryPage[] = [];
  const calls = {
    factory: 0,
    listThreadIds: [] as Array<{ query: string; maxResults: number; pageToken?: string }>,
    listHistory: [] as Array<{ startHistoryId: string; pageToken?: string }>,
    getThread: [] as string[],
    getThreadMetadata: [] as string[],
  };
  const fail = () => {
    if (seed.failWith) throw seed.failWith;
  };

  const api: GmailApi = {
    async getProfile() {
      fail();
      return { emailAddress: "me@gmail.com", historyId: seed.historyId ?? "1" };
    },
    async listThreadIds(input) {
      fail();
      calls.listThreadIds.push(input);
      const ids = Object.keys(threads);
      const start = input.pageToken ? Number(input.pageToken) : 0;
      const size = Math.min(input.maxResults, seed.pageSize ?? input.maxResults);
      const end = start + size;
      return { ids: ids.slice(start, end), nextPageToken: end < ids.length ? String(end) : null };
    },
    async getThreadMetadata(threadId) {
      fail();
      calls.getThreadMetadata.push(threadId);
      const sorted = [...(threads[threadId] ?? [])].sort(
        (a, b) => a.sentAt.getTime() - b.sentAt.getTime(),
      );
      const first = sorted[0];
      const last = sorted.at(-1);
      if (!first || !last) return null;
      return {
        providerThreadId: threadId,
        subject: first.subject,
        from: last.from,
        date: last.sentAt,
        snippet: last.snippet,
      };
    },
    async getThread(threadId) {
      fail();
      calls.getThread.push(threadId);
      seed.onGetThread?.(threadId, calls.getThread.length);
      const messages = threads[threadId];
      return messages ? { providerThreadId: threadId, messages: [...messages] } : null;
    },
    async listHistory(input) {
      fail();
      calls.listHistory.push(input);
      if (seed.historyExpired) throw new HistoryExpiredError();
      return (
        history.shift() ?? {
          changedThreadIds: [],
          deletedMessageIds: [],
          historyId: input.startHistoryId,
          nextPageToken: null,
        }
      );
    },
  };
  const factory: GmailApiFactory = () => {
    calls.factory += 1;
    return api;
  };
  return { factory, threads, history, calls };
}
