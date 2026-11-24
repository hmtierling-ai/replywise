import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../client";
import {
  insertMailAccount,
  insertMessage,
  insertThread,
  insertUser,
  resetTestDb,
  setupTestDb,
} from "../testing";
import {
  completeDraft,
  completeSummary,
  createPendingDraft,
  discardDraft,
  failDraft,
  failDraftSave,
  failSummary,
  getAutoDraftSetting,
  getDraftForUser,
  getSummary,
  getWritingPreferences,
  hasDraftForMessage,
  listDraftsForThread,
  markDraftSaved,
  requestDraftSave,
  requestSummary,
  setAutoDraft,
  setWritingPreferences,
  threadBelongsToUser,
  updateDraftBody,
} from "./generation";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

async function seedThread(opts: { withBob?: boolean } = {}) {
  const alice = await insertUser(db);
  const bob = opts.withBob ? await insertUser(db) : alice;
  const box = await insertMailAccount(db, alice.id);
  const thread = await insertThread(db, box.id, { providerLabels: ["INBOX"] });
  const message = await insertMessage(db, thread.id, box.id, { isFromUser: false });
  return { alice, bob, box, thread, message };
}

function newDraft(userId: string, threadId: string, forMessageId: string | null) {
  return createPendingDraft(db, {
    threadId,
    userId,
    tone: "friendly",
    instructions: "say yes",
    forMessageId,
    placeholderCiphertext: Buffer.from("p"),
    aiProvider: "anthropic",
    model: "claude-opus-5-5",
  });
}

describe("summaries", () => {
  it("requests, completes and fails a summary; a new request resets it to pending", async () => {
    const { thread, message } = await seedThread();
    await requestSummary(db, thread.id);
    expect(await getSummary(db, thread.id)).toMatchObject({ status: "pending", summary: null });
    await completeSummary(db, {
      threadId: thread.id,
      summary: "Ada asks to sign.",
      throughMessageId: message.id,
      model: "claude-opus-5-5",
    });
    expect(await getSummary(db, thread.id)).toMatchObject({
      status: "ready",
      summary: "Ada asks to sign.",
      throughMessageId: message.id,
      error: null,
    });
    await requestSummary(db, thread.id);
    expect(await getSummary(db, thread.id)).toMatchObject({
      status: "pending",
      summary: "Ada asks to sign.",
    });
    await failSummary(db, thread.id, "ai_unavailable");
    expect(await getSummary(db, thread.id)).toMatchObject({
      status: "failed",
      error: "ai_unavailable",
    });
  });
});

describe("reply drafts", () => {
  it("creates pending drafts, completes, edits, saves and discards them, scoped to the owner", async () => {
    const { alice, bob, thread, message } = await seedThread({ withBob: true });
    const id = await newDraft(alice.id, thread.id, message.id);
    expect((await getDraftForUser(db, alice.id, id))?.status).toBe("pending");
    expect(await getDraftForUser(db, bob.id, id)).toBeNull();
    expect(await hasDraftForMessage(db, thread.id, message.id)).toBe(true);

    await completeDraft(db, {
      draftId: id,
      bodyCiphertext: Buffer.from("b1"),
      model: "claude-haiku-5-5",
    });
    expect(await getDraftForUser(db, alice.id, id)).toMatchObject({
      status: "generated",
      model: "claude-haiku-5-5",
    });

    expect(await updateDraftBody(db, bob.id, id, Buffer.from("x"))).toBe(false);
    expect(await updateDraftBody(db, alice.id, id, Buffer.from("b2"))).toBe(true);
    expect(await getDraftForUser(db, alice.id, id)).toMatchObject({ status: "edited" });

    const now = new Date("2026-11-24T12:00:00Z");
    expect(await requestDraftSave(db, alice.id, id, now)).toBe(true);
    expect((await getDraftForUser(db, alice.id, id))?.saveRequestedAt).toEqual(now);
    await markDraftSaved(db, id, "r-123", now);
    expect(await getDraftForUser(db, alice.id, id)).toMatchObject({
      status: "saved",
      providerDraftId: "r-123",
      saveRequestedAt: null,
      error: null,
    });

    expect((await listDraftsForThread(db, alice.id, thread.id)).map((d) => d.id)).toEqual([id]);
    expect(await listDraftsForThread(db, bob.id, thread.id)).toEqual([]);

    expect(await discardDraft(db, alice.id, id)).toBe(true);
    expect(await listDraftsForThread(db, alice.id, thread.id)).toEqual([]);
  });

  it("records generation and save failures with fixed codes", async () => {
    const { alice, thread, message } = await seedThread();
    const pending = await newDraft(alice.id, thread.id, message.id);
    await failDraft(db, pending, "ai_refused");
    expect(await getDraftForUser(db, alice.id, pending)).toMatchObject({
      status: "failed",
      error: "ai_refused",
    });

    const id = await newDraft(alice.id, thread.id, null);
    await completeDraft(db, {
      draftId: id,
      bodyCiphertext: Buffer.from("b1"),
      model: "claude-opus-5-5",
    });
    expect(await requestDraftSave(db, alice.id, id, new Date())).toBe(true);
    await failDraftSave(db, id, "gmail_unavailable");
    expect(await getDraftForUser(db, alice.id, id)).toMatchObject({
      status: "generated",
      saveRequestedAt: null,
      error: "gmail_unavailable",
    });
  });
});

describe("draft state guards", () => {
  const body = (s: string) => ({ bodyCiphertext: Buffer.from(s), model: "claude-opus-5-5" });

  it("completeDraft and failDraft only act on pending drafts", async () => {
    const { alice, thread } = await seedThread();
    const id = await newDraft(alice.id, thread.id, null);
    await completeDraft(db, { draftId: id, ...body("b1") });
    await failDraft(db, id, "ai_refused");
    await completeDraft(db, { draftId: id, ...body("b2") });
    const row = await getDraftForUser(db, alice.id, id);
    expect(row).toMatchObject({ status: "generated", error: null });
    expect(row?.bodyCiphertext.toString()).toBe("b1");
  });

  it("discarding a pending draft keeps a later completeDraft from reviving it", async () => {
    const { alice, thread } = await seedThread();
    const id = await newDraft(alice.id, thread.id, null);
    expect(await discardDraft(db, alice.id, id)).toBe(true);
    await completeDraft(db, { draftId: id, ...body("b1") });
    expect((await getDraftForUser(db, alice.id, id))?.status).toBe("discarded");
  });

  it("rejects edits and save requests on pending, failed and discarded drafts", async () => {
    const { alice, thread } = await seedThread();
    const pending = await newDraft(alice.id, thread.id, null);
    const failed = await newDraft(alice.id, thread.id, null);
    await failDraft(db, failed, "ai_refused");
    const discarded = await newDraft(alice.id, thread.id, null);
    await discardDraft(db, alice.id, discarded);
    for (const id of [pending, failed, discarded]) {
      expect(await updateDraftBody(db, alice.id, id, Buffer.from("x"))).toBe(false);
      expect(await requestDraftSave(db, alice.id, id, new Date())).toBe(false);
    }
  });

  it("markDraftSaved and failDraftSave leave a draft discarded during an in-flight save alone", async () => {
    const { alice, thread } = await seedThread();
    const id = await newDraft(alice.id, thread.id, null);
    await completeDraft(db, { draftId: id, ...body("b1") });
    await requestDraftSave(db, alice.id, id, new Date());
    await discardDraft(db, alice.id, id);
    await markDraftSaved(db, id, "r-1", new Date());
    expect(await getDraftForUser(db, alice.id, id)).toMatchObject({
      status: "discarded",
      providerDraftId: null,
    });
    await failDraftSave(db, id, "gmail_unavailable");
    expect(await getDraftForUser(db, alice.id, id)).toMatchObject({
      status: "discarded",
      error: null,
    });
  });

  it("rejects edits while a save is in flight", async () => {
    const { alice, thread } = await seedThread();
    const id = await newDraft(alice.id, thread.id, null);
    await completeDraft(db, { draftId: id, ...body("b1") });
    await requestDraftSave(db, alice.id, id, new Date());
    expect(await updateDraftBody(db, alice.id, id, Buffer.from("x"))).toBe(false);
    expect((await getDraftForUser(db, alice.id, id))?.bodyCiphertext.toString()).toBe("b1");
  });

  it("does not let another user save-request or discard a draft", async () => {
    const { alice, bob, thread } = await seedThread({ withBob: true });
    const id = await newDraft(alice.id, thread.id, null);
    await completeDraft(db, { draftId: id, ...body("b1") });
    expect(await requestDraftSave(db, bob.id, id, new Date())).toBe(false);
    expect(await discardDraft(db, bob.id, id)).toBe(false);
    expect(await getDraftForUser(db, alice.id, id)).toMatchObject({
      status: "generated",
      saveRequestedAt: null,
    });
  });

  it("refuses to create a draft on a thread the user does not own", async () => {
    const { bob, thread } = await seedThread({ withBob: true });
    await expect(newDraft(bob.id, thread.id, null)).rejects.toThrow("thread_not_owned");
    expect(await listDraftsForThread(db, bob.id, thread.id)).toEqual([]);
  });

  it("hasDraftForMessage ignores failed drafts so auto-draft can retry", async () => {
    const { alice, thread, message } = await seedThread();
    const id = await newDraft(alice.id, thread.id, message.id);
    expect(await hasDraftForMessage(db, thread.id, message.id)).toBe(true);
    await failDraft(db, id, "ai_refused");
    expect(await hasDraftForMessage(db, thread.id, message.id)).toBe(false);
  });
});

describe("writing preferences and auto-draft", () => {
  it("updates existing preferences and can reset replyLanguage to null", async () => {
    const { alice } = await seedThread();
    await setWritingPreferences(db, alice.id, { replyLanguage: "pt" });
    expect((await getWritingPreferences(db, alice.id)).replyLanguage).toBe("pt");
    await setWritingPreferences(db, alice.id, { signature: "Ada", replyLanguage: null });
    expect(await getWritingPreferences(db, alice.id)).toMatchObject({
      signature: "Ada",
      replyLanguage: null,
    });
  });

  it("defaults, then stores writing preferences", async () => {
    const { alice } = await seedThread();
    expect(await getWritingPreferences(db, alice.id)).toEqual({
      defaultTone: "professional",
      signature: "",
      writingStyleNotes: "",
      replyLanguage: null,
      generationModel: "claude-opus-5-5",
    });
    await setWritingPreferences(db, alice.id, {
      defaultTone: "concise",
      signature: "— Ada",
      generationModel: "claude-haiku-5-5",
    });
    expect(await getWritingPreferences(db, alice.id)).toMatchObject({
      defaultTone: "concise",
      signature: "— Ada",
      generationModel: "claude-haiku-5-5",
      writingStyleNotes: "",
    });
  });

  it("toggles auto-draft only for the owner's mailbox", async () => {
    const { alice, bob, box } = await seedThread({ withBob: true });
    expect(await getAutoDraftSetting(db, box.id)).toBe(false);
    expect(await setAutoDraft(db, bob.id, box.id, true)).toBe(false);
    expect(await setAutoDraft(db, alice.id, box.id, true)).toBe(true);
    expect(await getAutoDraftSetting(db, box.id)).toBe(true);
  });

  it("checks thread ownership", async () => {
    const { alice, bob, thread } = await seedThread({ withBob: true });
    expect(await threadBelongsToUser(db, alice.id, thread.id)).toBe(true);
    expect(await threadBelongsToUser(db, bob.id, thread.id)).toBe(false);
  });
});
