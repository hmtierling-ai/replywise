// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const DRAFT_ID = "22222222-2222-4222-8222-222222222222";
const BOX_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-11-25T12:00:00Z");
const STORED = "Hi Ada,\n\nYes.";

const { enqueue, removeJob, encryptor, dbMocks } = vi.hoisted(() => ({
  enqueue: vi.fn(),
  removeJob: vi.fn(),
  encryptor: { decryptString: vi.fn() },
  dbMocks: {
    countRecentSends: vi.fn(),
    getDraftForUser: vi.fn(),
    getDraftMailbox: vi.fn(),
    insertAuditLog: vi.fn(),
    reopenFailedSend: vi.fn(),
    scheduleSend: vi.fn(),
    undoSend: vi.fn(),
    SEND_DELAY_MS: 10_000,
    SEND_RATE_LIMIT: 20,
  },
}));

vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "user-1" }) }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/queue", () => ({ getQueue: () => ({ enqueue, removeJob }) }));
vi.mock("@/lib/crypto", () => ({ getEncryptor: () => encryptor }));
vi.mock("@/lib/mailbox", () => ({ requestContext: () => ({ ip: null, userAgent: null }) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@replywise/db", () => dbMocks);
vi.mock("@replywise/queue", () => ({
  sendJobId: (draftId: string, sendAt: Date) => `send_${draftId}_${sendAt.getTime()}`,
}));

import { editFailedSendAction, scheduleSendAction, undoSendAction } from "./send-actions";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  enqueue.mockResolvedValue(undefined);
  removeJob.mockResolvedValue(undefined);
  encryptor.decryptString.mockResolvedValue(STORED);
  dbMocks.getDraftForUser.mockResolvedValue({
    id: DRAFT_ID,
    threadId: THREAD_ID,
    status: "edited",
    bodyCiphertext: Buffer.from("ct"),
  });
  dbMocks.getDraftMailbox.mockResolvedValue({
    threadId: THREAD_ID,
    mailAccountId: BOX_ID,
    provider: "gmail",
  });
  dbMocks.countRecentSends.mockResolvedValue(0);
  dbMocks.scheduleSend.mockResolvedValue(true);
  dbMocks.undoSend.mockResolvedValue({ sendAt: new Date(NOW.getTime() + 10_000) });
  dbMocks.insertAuditLog.mockResolvedValue(undefined);
  dbMocks.reopenFailedSend.mockResolvedValue(true);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("scheduleSendAction", () => {
  it("schedules exactly what was confirmed and enqueues one delayed job", async () => {
    await expect(
      scheduleSendAction({ draftId: DRAFT_ID, expectedBody: "Hi Ada,\r\n\r\nYes." }),
    ).resolves.toEqual({ ok: true });
    const sendAt = new Date(NOW.getTime() + 10_000);
    expect(dbMocks.scheduleSend).toHaveBeenCalledWith({}, "user-1", DRAFT_ID, sendAt, NOW);
    expect(enqueue).toHaveBeenCalledWith(
      "draft.send",
      { draftId: DRAFT_ID },
      { jobId: `send_${DRAFT_ID}_${sendAt.getTime()}`, delayMs: 10_000 },
    );
    expect(dbMocks.insertAuditLog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        userId: "user-1",
        action: "draft.send_scheduled",
        metadata: { draftId: DRAFT_ID, threadId: THREAD_ID, mailAccountId: BOX_ID },
      }),
    );
    expect(JSON.stringify(dbMocks.insertAuditLog.mock.calls)).not.toContain("Ada");
  });

  it("refuses when the stored body differs from the confirmed one", async () => {
    await expect(
      scheduleSendAction({ draftId: DRAFT_ID, expectedBody: "Hi Ada,\n\nNo." }),
    ).resolves.toEqual({ ok: false, error: "draft_changed" });
    expect(dbMocks.scheduleSend).not.toHaveBeenCalled();
  });

  it("refuses non-Gmail mailboxes, foreign drafts and bad ids", async () => {
    dbMocks.getDraftMailbox.mockResolvedValueOnce({
      threadId: THREAD_ID,
      mailAccountId: BOX_ID,
      provider: "outlook",
    });
    await expect(scheduleSendAction({ draftId: DRAFT_ID, expectedBody: STORED })).resolves.toEqual({
      ok: false,
      error: "not_sendable",
    });
    dbMocks.getDraftForUser.mockResolvedValueOnce(null);
    await expect(scheduleSendAction({ draftId: DRAFT_ID, expectedBody: STORED })).resolves.toEqual({
      ok: false,
      error: "not_sendable",
    });
    await expect(scheduleSendAction({ draftId: "nope", expectedBody: STORED })).resolves.toEqual({
      ok: false,
      error: "not_sendable",
    });
    expect(dbMocks.scheduleSend).not.toHaveBeenCalled();
  });

  it("refuses at 20 sends in the last hour", async () => {
    dbMocks.countRecentSends.mockResolvedValue(20);
    await expect(scheduleSendAction({ draftId: DRAFT_ID, expectedBody: STORED })).resolves.toEqual({
      ok: false,
      error: "send_rate_limited",
    });
    expect(dbMocks.scheduleSend).not.toHaveBeenCalled();
  });

  it("enqueues nothing when the draft cannot be scheduled", async () => {
    dbMocks.scheduleSend.mockResolvedValue(false);
    await expect(scheduleSendAction({ draftId: DRAFT_ID, expectedBody: STORED })).resolves.toEqual({
      ok: false,
      error: "not_sendable",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("hands control back when the job cannot be enqueued", async () => {
    enqueue.mockRejectedValue(new Error("redis down"));
    await expect(scheduleSendAction({ draftId: DRAFT_ID, expectedBody: STORED })).resolves.toEqual({
      ok: false,
      error: "internal",
    });
    expect(dbMocks.undoSend).toHaveBeenCalledWith({}, "user-1", DRAFT_ID, NOW);
  });
});

describe("undoSendAction", () => {
  it("returns the draft to editing, removes the delayed job and audits", async () => {
    await expect(undoSendAction({ draftId: DRAFT_ID })).resolves.toEqual({ ok: true });
    expect(removeJob).toHaveBeenCalledWith("send", `send_${DRAFT_ID}_${NOW.getTime() + 10_000}`);
    expect(dbMocks.insertAuditLog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ action: "draft.send_undone" }),
    );
  });

  it("still succeeds when the delayed job cannot be removed", async () => {
    removeJob.mockRejectedValue(new Error("job is locked"));
    await expect(undoSendAction({ draftId: DRAFT_ID })).resolves.toEqual({ ok: true });
  });

  it("reports too_late once the worker claimed the send", async () => {
    dbMocks.undoSend.mockResolvedValue(null);
    await expect(undoSendAction({ draftId: DRAFT_ID })).resolves.toEqual({
      ok: false,
      error: "too_late",
    });
    expect(removeJob).not.toHaveBeenCalled();
  });
});

describe("editFailedSendAction", () => {
  it("reopens a failed send for editing", async () => {
    const data = new FormData();
    data.set("draftId", DRAFT_ID);
    data.set("threadId", THREAD_ID);
    await editFailedSendAction(data);
    expect(dbMocks.reopenFailedSend).toHaveBeenCalledWith({}, "user-1", DRAFT_ID, NOW);
  });
});
