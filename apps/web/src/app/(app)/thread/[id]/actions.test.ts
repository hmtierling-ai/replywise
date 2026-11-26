// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const DRAFT_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";

const { enqueue, encryptor, dbMocks } = vi.hoisted(() => {
  const enqueue = vi.fn();
  const encryptor = {
    encrypt: vi.fn(async (text: string) => Buffer.from(`enc:${text}`)),
    decryptString: vi.fn(async () => "stored body"),
  };
  const dbMocks = {
    createPendingDraft: vi.fn(),
    discardDraft: vi.fn(),
    failDraft: vi.fn(),
    failDraftSave: vi.fn(),
    failSummary: vi.fn(),
    getAiCredentialSummary: vi.fn(),
    getDraftForUser: vi.fn(),
    getWritingPreferences: vi.fn(),
    hasActiveSend: vi.fn(),
    hasFreshPendingDraft: vi.fn(),
    latestInboundMessageId: vi.fn(),
    requestDraftSave: vi.fn(),
    requestSummary: vi.fn(),
    threadBelongsToUser: vi.fn(),
    updateDraftBody: vi.fn(),
  };
  return { enqueue, encryptor, dbMocks };
});

vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "user-1" }) }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/queue", () => ({ getQueue: () => ({ enqueue }) }));
vi.mock("@/lib/crypto", () => ({ getEncryptor: () => encryptor }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@replywise/db", () => dbMocks);

import {
  discardDraftAction,
  generateDraftAction,
  saveDraftEditAction,
  saveDraftToGmailAction,
  summarizeThreadAction,
} from "./actions";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function draftRow(status = "generated") {
  return {
    id: DRAFT_ID,
    threadId: THREAD_ID,
    status,
    bodyCiphertext: Buffer.from("ct"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  enqueue.mockResolvedValue(undefined);
  encryptor.decryptString.mockResolvedValue("stored body");
  dbMocks.threadBelongsToUser.mockResolvedValue(true);
  dbMocks.getAiCredentialSummary.mockResolvedValue({ status: "valid" });
  dbMocks.requestSummary.mockResolvedValue(true);
  dbMocks.hasActiveSend.mockResolvedValue(false);
  dbMocks.hasFreshPendingDraft.mockResolvedValue(false);
  dbMocks.getWritingPreferences.mockResolvedValue({
    defaultTone: "professional",
    generationModel: "claude-opus-5-5",
  });
  dbMocks.latestInboundMessageId.mockResolvedValue(MESSAGE_ID);
  dbMocks.createPendingDraft.mockResolvedValue(DRAFT_ID);
  dbMocks.getDraftForUser.mockResolvedValue(draftRow());
  dbMocks.requestDraftSave.mockResolvedValue(true);
  dbMocks.updateDraftBody.mockResolvedValue(true);
});

describe("summarizeThreadAction", () => {
  it("marks the summary failed with a fixed code when enqueue throws, without throwing", async () => {
    enqueue.mockRejectedValue(new Error("redis down"));
    await expect(summarizeThreadAction(form({ threadId: THREAD_ID }))).resolves.toBeUndefined();
    expect(dbMocks.failSummary).toHaveBeenCalledWith({}, THREAD_ID, "internal");
  });

  it("enqueues nothing while a fresh request exists", async () => {
    dbMocks.requestSummary.mockResolvedValue(false);
    await summarizeThreadAction(form({ threadId: THREAD_ID }));
    expect(enqueue).not.toHaveBeenCalled();
    expect(dbMocks.failSummary).not.toHaveBeenCalled();
  });
});

describe("generateDraftAction", () => {
  it("marks the draft failed with a fixed code when enqueue throws, without throwing", async () => {
    enqueue.mockRejectedValue(new Error("redis down"));
    await expect(generateDraftAction(form({ threadId: THREAD_ID }))).resolves.toBeUndefined();
    expect(dbMocks.failDraft).toHaveBeenCalledWith({}, DRAFT_ID, "internal");
  });

  it("does not regenerate while a send of this thread is scheduled or sending", async () => {
    dbMocks.hasActiveSend.mockResolvedValue(true);
    await generateDraftAction(form({ threadId: THREAD_ID }));
    expect(dbMocks.createPendingDraft).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("enqueues nothing and creates no draft while a fresh pending draft exists", async () => {
    dbMocks.hasFreshPendingDraft.mockResolvedValue(true);
    await generateDraftAction(form({ threadId: THREAD_ID }));
    expect(dbMocks.createPendingDraft).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("answers the newest inbound message", async () => {
    await generateDraftAction(form({ threadId: THREAD_ID }));
    expect(dbMocks.latestInboundMessageId).toHaveBeenCalledWith({}, "user-1", THREAD_ID);
    expect(dbMocks.createPendingDraft).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ forMessageId: MESSAGE_ID, userId: "user-1" }),
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("saveDraftToGmailAction", () => {
  const fields = { threadId: THREAD_ID, draftId: DRAFT_ID, body: "stored body" };

  it("fails the save with a fixed code when enqueue throws, without throwing", async () => {
    enqueue.mockRejectedValue(new Error("redis down"));
    await expect(saveDraftToGmailAction(form(fields))).resolves.toBeUndefined();
    expect(dbMocks.failDraftSave).toHaveBeenCalledWith({}, DRAFT_ID, "internal");
  });

  it("enqueues nothing while another save is in flight", async () => {
    dbMocks.requestDraftSave.mockResolvedValue(false);
    await saveDraftToGmailAction(form(fields));
    expect(enqueue).not.toHaveBeenCalled();
    expect(dbMocks.failDraftSave).not.toHaveBeenCalled();
  });

  it("does not rewrite an unchanged body", async () => {
    await saveDraftToGmailAction(form(fields));
    expect(dbMocks.updateDraftBody).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("persists an edited body before requesting the save", async () => {
    await saveDraftToGmailAction(form({ ...fields, body: "new body" }));
    expect(dbMocks.updateDraftBody).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("saves nothing when the stored body cannot be decrypted", async () => {
    encryptor.decryptString.mockRejectedValue(new Error("bad tag"));
    await expect(saveDraftToGmailAction(form(fields))).resolves.toBeUndefined();
    expect(dbMocks.updateDraftBody).not.toHaveBeenCalled();
    expect(dbMocks.requestDraftSave).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("saveDraftEditAction", () => {
  it("rewrites the body of an owned draft", async () => {
    await saveDraftEditAction(form({ threadId: THREAD_ID, draftId: DRAFT_ID, body: "edit" }));
    expect(dbMocks.updateDraftBody).toHaveBeenCalledTimes(1);
  });
});

describe("discardDraftAction", () => {
  it("discards an owned draft", async () => {
    await discardDraftAction(form({ threadId: THREAD_ID, draftId: DRAFT_ID }));
    expect(dbMocks.discardDraft).toHaveBeenCalledWith({}, "user-1", DRAFT_ID);
  });
});
