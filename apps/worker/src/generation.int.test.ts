import { AiRateLimitedError, AiRefusalError } from "@replywise/ai";
import { createFakeAiProvider } from "@replywise/ai/testing";
import { aad } from "@replywise/crypto";
import {
  auditLogs,
  createPendingDraft,
  discardDraft,
  getDraftForWorker,
  getSummary,
  mailAccounts,
  markAiCredentialInvalid,
  markDraftSaved,
  messages,
  replyDrafts,
  requestDraftSave,
  requestSummary,
  SAVE_STALE_MS,
  saveAiCredential,
  setAutoDraft,
  setWritingPreferences,
  summarizeAiUsage,
  threadInsights,
} from "@replywise/db";
import {
  insertMailAccount,
  insertMessage,
  insertThread,
  insertUser,
  resetTestDb,
  setupTestDb,
} from "@replywise/db/testing";
import { type GmailDraftsApi, ProviderHttpError } from "@replywise/mail";
import { createFakeProvider, testEncryptor } from "@replywise/mailbox/testing";
import { createLogger } from "@replywise/observability";
import type { JobQueue } from "@replywise/queue";
import { encryptBody } from "@replywise/sync";
import { UnrecoverableError } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { classifyThreadHandler } from "./jobs/classify-thread";
import { generateDraftHandler } from "./jobs/generate-draft";
import { saveDraftHandler } from "./jobs/save-draft";
import { summarizeThreadHandler } from "./jobs/summarize-thread";

let handle: Awaited<ReturnType<typeof setupTestDb>>;
const encryptor = testEncryptor();
const logger = createLogger({ name: "test", level: "silent" });
const ctx = { jobId: "t", attempt: 1 };
const lastCtx = { jobId: "t", attempt: 5 };
const HOUR_MS = 3_600_000;
const DRAFT_TEXT = "Hi Ada,\n\nYes — I'll sign it by Friday.";

beforeAll(async () => {
  handle = await setupTestDb();
  // Leftovers from an aborted run would make every write fail.
  await handle.db.execute(sql`alter table reply_drafts drop constraint if exists g7_fail`);
  await handle.db.execute(sql`alter table thread_summaries drop constraint if exists s7_fail`);
});
afterAll(async () => handle.close());
beforeEach(async () => resetTestDb(handle.db));

async function seed() {
  const { db } = handle;
  const user = await insertUser(db, { name: "Me" });
  const account = await insertMailAccount(db, user.id, { emailAddress: "me@gmail.com" });
  // Far-future expiry: getValidAccessToken returns the stored token without a refresh.
  const tokens = {
    accessToken: "access-stored",
    refreshToken: "refresh-stored",
    expiresAt: new Date(Date.now() + 365 * 24 * HOUR_MS).toISOString(),
  };
  await db
    .update(mailAccounts)
    .set({
      tokensCiphertext: await encryptor.encrypt(JSON.stringify(tokens), aad.mailTokens(account.id)),
    })
    .where(eq(mailAccounts.id, account.id));
  const thread = await insertThread(db, account.id, {
    subject: "Contract",
    providerLabels: ["INBOX"],
    lastMessageAt: new Date(Date.now() - HOUR_MS),
  });
  const m1 = await insertMessage(db, thread.id, account.id, {
    fromAddress: { name: "Ada", address: "ada@client.com" },
    toAddresses: [{ name: null, address: "me@gmail.com" }],
    internetMessageId: "<m1@client.com>",
    sentAt: new Date(Date.now() - HOUR_MS),
    snippet: "Can you sign?",
  });
  await db
    .update(messages)
    .set({
      bodyCiphertext: await encryptBody(encryptor, m1.id, {
        text: "Can you sign the contract by Friday?",
        html: null,
      }),
    })
    .where(eq(messages.id, m1.id));
  await saveAiCredential(db, {
    userId: user.id,
    keyCiphertext: await encryptor.encrypt(
      "sk-ant-test-key",
      aad.aiCredential(user.id, "anthropic"),
    ),
    keyHint: "-key",
    status: "valid",
    lastValidatedAt: new Date(),
  });
  await setWritingPreferences(db, user.id, {
    signature: "— Me",
    writingStyleNotes: "Short sentences.",
    generationModel: "claude-opus-5-5",
  });
  return { user, account, thread, m1 };
}

async function pendingDraft(
  s: Awaited<ReturnType<typeof seed>>,
  overrides: {
    tone?: "friendly" | "professional";
    instructions?: string | null;
    forMessageId?: string;
  } = {},
) {
  return createPendingDraft(handle.db, {
    threadId: s.thread.id,
    userId: s.user.id,
    tone: overrides.tone ?? "friendly",
    instructions: overrides.instructions ?? "Say yes",
    forMessageId: overrides.forMessageId ?? s.m1.id,
    placeholderCiphertext: await encryptor.encrypt("", aad.replyDraft("pending")),
    aiProvider: "anthropic",
    model: "claude-opus-5-5",
  });
}

async function generatedDraft(s: Awaited<ReturnType<typeof seed>>) {
  const draftId = await pendingDraft(s);
  await generateDraftHandler({ db: handle.db, encryptor, ai: createFakeAiProvider(), logger })(
    { draftId },
    ctx,
  );
  return draftId;
}

function fakeGmailDrafts(
  options: { updateResult?: { draftId: string } | null; error?: Error; createId?: string } = {},
) {
  const calls = {
    create: [] as Array<{ raw: string; threadId: string }>,
    update: [] as Array<{ id: string; raw: string; threadId: string }>,
    tokens: [] as string[],
  };
  const factory = (accessToken: string): GmailDraftsApi => {
    calls.tokens.push(accessToken);
    return {
      async createDraft(input) {
        calls.create.push(input);
        if (options.error) throw options.error;
        return { draftId: options.createId ?? "r-1" };
      },
      async updateDraft(id, input) {
        calls.update.push({ id, ...input });
        if (options.error) throw options.error;
        return options.updateResult === undefined ? { draftId: id } : options.updateResult;
      },
    };
  };
  return { factory, calls };
}

function saveDeps(gmailDrafts: ReturnType<typeof fakeGmailDrafts>["factory"]) {
  const { db } = handle;
  return {
    db,
    encryptor,
    logger,
    gmailDrafts,
    mailbox: { db, encryptor, providers: { gmail: createFakeProvider("gmail").provider } },
  };
}

const decodeRaw = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");
/** The MIME body is base64 (76-column lines) after the blank line. */
const mimeBody = (mime: string) =>
  Buffer.from(mime.split("\r\n\r\n").slice(1).join("").replace(/\r\n/g, ""), "base64").toString(
    "utf8",
  );

describe("summarizeThreadHandler", () => {
  it("stores the summary through the newest message and records usage", async () => {
    const { db } = handle;
    const s = await seed();
    await requestSummary(db, s.thread.id);
    const ai = createFakeAiProvider({ summary: "Ada wants a signature by Friday." });
    await summarizeThreadHandler({ db, encryptor, ai, logger })({ threadId: s.thread.id }, ctx);
    expect(await getSummary(db, s.thread.id)).toMatchObject({
      status: "ready",
      summary: "Ada wants a signature by Friday.",
      throughMessageId: s.m1.id,
      model: "claude-opus-5-5",
      error: null,
    });
    expect(ai.summarizeCalls[0]?.model).toBe("claude-opus-5-5");
    expect(await summarizeAiUsage(db, s.user.id, new Date(0))).toEqual([
      expect.objectContaining({ task: "summarize", model: "claude-opus-5-5", calls: 1 }),
    ]);
  });

  it("fails with no_ai_key without calling the provider when there is no valid key", async () => {
    const { db } = handle;
    const s = await seed();
    await markAiCredentialInvalid(db, s.user.id);
    await requestSummary(db, s.thread.id);
    const ai = createFakeAiProvider();
    await summarizeThreadHandler({ db, encryptor, ai, logger })({ threadId: s.thread.id }, ctx);
    expect(await getSummary(db, s.thread.id)).toMatchObject({
      status: "failed",
      error: "no_ai_key",
    });
    expect(ai.summarizeCalls).toHaveLength(0);
  });

  it("stays pending on a retryable error until the final attempt", async () => {
    const { db } = handle;
    const s = await seed();
    await requestSummary(db, s.thread.id);
    const error = new AiRateLimitedError();
    const handler = summarizeThreadHandler({
      db,
      encryptor,
      ai: createFakeAiProvider({ error }),
      logger,
    });
    await expect(handler({ threadId: s.thread.id }, ctx)).rejects.toBe(error);
    expect(await getSummary(db, s.thread.id)).toMatchObject({ status: "pending", error: null });
    await expect(handler({ threadId: s.thread.id }, lastCtx)).rejects.toBe(error);
    expect(await getSummary(db, s.thread.id)).toMatchObject({
      status: "failed",
      error: "ai_unavailable",
    });
  });
});

describe("summarizeThreadHandler guards", () => {
  it("does nothing unless a summary was requested and is still pending", async () => {
    const { db } = handle;
    const s = await seed();
    const ai = createFakeAiProvider();
    const handler = summarizeThreadHandler({ db, encryptor, ai, logger });
    await handler({ threadId: s.thread.id }, ctx); // never requested
    await requestSummary(db, s.thread.id);
    await handler({ threadId: s.thread.id }, ctx);
    await handler({ threadId: s.thread.id }, ctx); // duplicate job: already ready
    expect(ai.summarizeCalls).toHaveLength(1);
    expect((await getSummary(db, s.thread.id))?.status).toBe("ready");
  });

  it("pays once when the summary write keeps failing", async () => {
    const { db } = handle;
    const s = await seed();
    await requestSummary(db, s.thread.id);
    const ai = createFakeAiProvider();
    const handler = summarizeThreadHandler({ db, encryptor, ai, logger });
    await db.execute(
      sql`alter table thread_summaries add constraint s7_fail check (status <> 'ready') not valid`,
    );
    let rejection: unknown;
    try {
      rejection = await handler({ threadId: s.thread.id }, ctx).catch((e: unknown) => e);
      await handler({ threadId: s.thread.id }, { jobId: "t", attempt: 2 });
    } finally {
      await db.execute(sql`alter table thread_summaries drop constraint if exists s7_fail`);
    }
    expect(rejection).toBeInstanceOf(UnrecoverableError);
    expect((rejection as Error).message).toBe("SummaryWriteFailed");
    expect(ai.summarizeCalls).toHaveLength(1);
    expect(await getSummary(db, s.thread.id)).toMatchObject({
      status: "failed",
      error: "internal",
    });
  });
});

describe("generateDraftHandler", () => {
  it("pays once when the draft write keeps failing", async () => {
    const { db } = handle;
    const s = await seed();
    const draftId = await pendingDraft(s);
    const ai = createFakeAiProvider();
    const handler = generateDraftHandler({ db, encryptor, ai, logger });
    await db.execute(
      sql`alter table reply_drafts add constraint g7_fail check (status <> 'generated') not valid`,
    );
    let rejection: unknown;
    try {
      rejection = await handler({ draftId }, ctx).catch((e: unknown) => e);
      await handler({ draftId }, { jobId: "t", attempt: 2 });
    } finally {
      await db.execute(sql`alter table reply_drafts drop constraint if exists g7_fail`);
    }
    expect(rejection).toBeInstanceOf(UnrecoverableError);
    expect((rejection as Error).message).toBe("DraftWriteFailed");
    expect(ai.draftCalls).toHaveLength(1);
    expect(await getDraftForWorker(db, draftId)).toMatchObject({
      status: "failed",
      error: "internal",
    });
  });

  it("generates the body with the draft's tone and instructions and records usage", async () => {
    const { db } = handle;
    const s = await seed();
    const draftId = await pendingDraft(s);
    const ai = createFakeAiProvider({ draft: DRAFT_TEXT });
    await generateDraftHandler({ db, encryptor, ai, logger })({ draftId }, ctx);
    const draft = await getDraftForWorker(db, draftId);
    expect(draft).toMatchObject({ status: "generated", error: null, model: "claude-opus-5-5" });
    expect(
      await encryptor.decryptString(
        draft?.bodyCiphertext ?? Buffer.alloc(0),
        aad.replyDraft(draftId),
      ),
    ).toBe(DRAFT_TEXT);
    expect(ai.draftCalls[0]?.input).toMatchObject({
      tone: "friendly",
      instructions: "Say yes",
      writingStyleNotes: "Short sentences.",
      replyLanguage: null,
      subject: "Contract",
    });
    expect(await summarizeAiUsage(db, s.user.id, new Date(0))).toEqual([
      expect.objectContaining({ task: "draft", calls: 1 }),
    ]);
  });

  it("fails with ai_refused and stops retries when the provider refuses", async () => {
    const { db } = handle;
    const s = await seed();
    const draftId = await pendingDraft(s);
    const ai = createFakeAiProvider({ error: new AiRefusalError() });
    const rejection = await generateDraftHandler({ db, encryptor, ai, logger })(
      { draftId },
      ctx,
    ).catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(UnrecoverableError);
    expect((rejection as Error).message).toBe("AiRefusalError");
    const draft = await getDraftForWorker(db, draftId);
    expect(draft?.status).toBe("failed");
    expect(draft?.error).toBe("ai_refused");
  });

  it("leaves the draft pending on a retryable error until the final attempt", async () => {
    const { db } = handle;
    const s = await seed();
    const draftId = await pendingDraft(s);
    const error = new AiRateLimitedError();
    const handler = generateDraftHandler({
      db,
      encryptor,
      ai: createFakeAiProvider({ error }),
      logger,
    });
    await expect(handler({ draftId }, ctx)).rejects.toBe(error);
    expect((await getDraftForWorker(db, draftId))?.status).toBe("pending");
    await expect(handler({ draftId }, lastCtx)).rejects.toBe(error);
    expect(await getDraftForWorker(db, draftId)).toMatchObject({
      status: "failed",
      error: "ai_unavailable",
    });
  });
});

describe("saveDraftHandler", () => {
  it("creates a Gmail draft in the thread with reply headers and the signature", async () => {
    const { db } = handle;
    const s = await seed();
    const draftId = await generatedDraft(s);
    expect(await requestDraftSave(db, s.user.id, draftId, new Date())).toBe(true);
    const gmail = fakeGmailDrafts();
    await saveDraftHandler(saveDeps(gmail.factory))({ draftId }, ctx);

    expect(gmail.calls.tokens).toEqual(["access-stored"]);
    expect(gmail.calls.update).toHaveLength(0);
    expect(gmail.calls.create).toHaveLength(1);
    expect(gmail.calls.create[0]?.threadId).toBe(s.thread.providerThreadId);
    const mime = decodeRaw(gmail.calls.create[0]?.raw ?? "");
    expect(mime).toMatch(/^To: .*ada@client\.com/m);
    expect(mime).toContain("In-Reply-To: <m1@client.com>");
    expect(mimeBody(mime)).toBe(`${DRAFT_TEXT.replace(/\n/g, "\r\n")}\r\n\r\n— Me`);

    const draft = await getDraftForWorker(db, draftId);
    expect(draft).toMatchObject({ status: "saved", providerDraftId: "r-1", saveRequestedAt: null });
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.action, "draft.saved"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      userId: s.user.id,
      targetType: "reply_draft",
      targetId: draftId,
    });
    expect(JSON.stringify(audit[0]?.metadata)).not.toMatch(/Ada|Friday|Me/);
  });

  it("updates the existing Gmail draft, and recreates it when Gmail no longer has it", async () => {
    const { db } = handle;
    const s = await seed();
    const draftId = await generatedDraft(s);
    await markDraftSaved(db, draftId, "r-1", new Date());

    await requestDraftSave(db, s.user.id, draftId, new Date());
    const existing = fakeGmailDrafts();
    await saveDraftHandler(saveDeps(existing.factory))({ draftId }, ctx);
    expect(existing.calls.update.map((c) => c.id)).toEqual(["r-1"]);
    expect(existing.calls.create).toHaveLength(0);
    expect(await getDraftForWorker(db, draftId)).toMatchObject({
      status: "saved",
      providerDraftId: "r-1",
    });

    await requestDraftSave(db, s.user.id, draftId, new Date());
    const gone = fakeGmailDrafts({ updateResult: null, createId: "r-2" });
    await saveDraftHandler(saveDeps(gone.factory))({ draftId }, ctx);
    expect(gone.calls.update.map((c) => c.id)).toEqual(["r-1"]);
    expect(gone.calls.create).toHaveLength(1);
    expect(await getDraftForWorker(db, draftId)).toMatchObject({
      status: "saved",
      providerDraftId: "r-2",
      saveRequestedAt: null,
    });
  });

  it("keeps the save requested on a Gmail 500 for an update until the final attempt, then fails it", async () => {
    const { db } = handle;
    const s = await seed();
    const draftId = await generatedDraft(s);
    await markDraftSaved(db, draftId, "r-1", new Date());
    await requestDraftSave(db, s.user.id, draftId, new Date());
    const gmail = fakeGmailDrafts({
      error: new ProviderHttpError(500, "/gmail/v1/users/me/drafts/{id}"),
    });
    const handler = saveDraftHandler(saveDeps(gmail.factory));

    const first = await handler({ draftId }, ctx).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(ProviderHttpError);
    expect(first).not.toBeInstanceOf(UnrecoverableError);
    expect(await getDraftForWorker(db, draftId)).toMatchObject({ error: null });
    expect((await getDraftForWorker(db, draftId))?.saveRequestedAt).not.toBeNull();

    const last = await handler({ draftId }, lastCtx).catch((e: unknown) => e);
    expect(last).toBeInstanceOf(ProviderHttpError);
    expect((last as Error).message).not.toMatch(/Ada|Friday/);
    expect(gmail.calls.create).toHaveLength(0);
    expect(await getDraftForWorker(db, draftId)).toMatchObject({
      status: "saved",
      saveRequestedAt: null,
      error: "gmail_unavailable",
    });
  });

  it("does not retry a create that timed out, since Gmail may hold the draft", async () => {
    const { db } = handle;
    const s = await seed();
    const draftId = await generatedDraft(s);
    await requestDraftSave(db, s.user.id, draftId, new Date());
    const gmail = fakeGmailDrafts({ error: new ProviderHttpError(0, "/gmail/v1/users/me/drafts") });
    const rejection = await saveDraftHandler(saveDeps(gmail.factory))({ draftId }, ctx).catch(
      (e: unknown) => e,
    );
    expect(rejection).toBeInstanceOf(UnrecoverableError);
    expect(await getDraftForWorker(db, draftId)).toMatchObject({
      saveRequestedAt: null,
      error: "gmail_unavailable",
    });
  });

  it("does not retry a create that failed with a 503, since Gmail may hold the draft", async () => {
    const { db } = handle;
    const s = await seed();
    const draftId = await generatedDraft(s);
    await requestDraftSave(db, s.user.id, draftId, new Date());
    const gmail = fakeGmailDrafts({
      error: new ProviderHttpError(503, "/gmail/v1/users/me/drafts"),
    });
    const rejection = await saveDraftHandler(saveDeps(gmail.factory))({ draftId }, ctx).catch(
      (e: unknown) => e,
    );
    expect(rejection).toBeInstanceOf(UnrecoverableError);
    expect((rejection as Error).message).toBe("ProviderHttpError");
    expect(gmail.calls.create).toHaveLength(1);
    expect(await getDraftForWorker(db, draftId)).toMatchObject({
      saveRequestedAt: null,
      error: "gmail_unavailable",
    });
  });

  it("does not act on a stale save request", async () => {
    const { db } = handle;
    const s = await seed();
    const draftId = await generatedDraft(s);
    await requestDraftSave(db, s.user.id, draftId, new Date(Date.now() - SAVE_STALE_MS - 1000));
    const gmail = fakeGmailDrafts();
    await saveDraftHandler(saveDeps(gmail.factory))({ draftId }, ctx);
    expect(gmail.calls.tokens).toHaveLength(0);
    expect(gmail.calls.create).toHaveLength(0);
    expect((await getDraftForWorker(db, draftId))?.status).toBe("generated");
  });

  it("retries a rate-limited create and keeps the save requested", async () => {
    const { db } = handle;
    const s = await seed();
    const draftId = await generatedDraft(s);
    await requestDraftSave(db, s.user.id, draftId, new Date());
    const error = new ProviderHttpError(429, "/gmail/v1/users/me/drafts", true);
    const gmail = fakeGmailDrafts({ error });
    const rejection = await saveDraftHandler(saveDeps(gmail.factory))({ draftId }, ctx).catch(
      (e: unknown) => e,
    );
    expect(rejection).toBe(error);
    const draft = await getDraftForWorker(db, draftId);
    expect(draft?.saveRequestedAt).not.toBeNull();
    expect(draft?.error).toBeNull();
  });

  it("skips the audit entry when the draft is discarded while the save runs", async () => {
    const { db } = handle;
    const s = await seed();
    const draftId = await generatedDraft(s);
    await requestDraftSave(db, s.user.id, draftId, new Date());
    const gmail = fakeGmailDrafts();
    const factory = (token: string): GmailDraftsApi => {
      const api = gmail.factory(token);
      return {
        ...api,
        async createDraft(input) {
          // Only a stale request can be discarded, so move the clock past SAVE_STALE_MS.
          await discardDraft(db, s.user.id, draftId, new Date(Date.now() + SAVE_STALE_MS + 1000));
          return api.createDraft(input);
        },
      };
    };
    await saveDraftHandler(saveDeps(factory))({ draftId }, ctx);
    expect(gmail.calls.create).toHaveLength(1);
    expect(await getDraftForWorker(db, draftId)).toMatchObject({
      status: "discarded",
      providerDraftId: null,
    });
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.action, "draft.saved"));
    expect(audit).toEqual([]);
  });

  it("never replies to the user's own message, even when the draft was made for it", async () => {
    const { db } = handle;
    const s = await seed();
    const own = await insertMessage(db, s.thread.id, s.account.id, {
      isFromUser: true,
      fromAddress: { name: "Me", address: "me@gmail.com" },
      toAddresses: [{ name: "Ada", address: "ada@client.com" }],
      internetMessageId: "<m2@gmail.com>",
      sentAt: new Date(Date.now() - HOUR_MS / 2),
    });
    const draftId = await pendingDraft(s, { forMessageId: own.id });
    await generateDraftHandler({ db, encryptor, ai: createFakeAiProvider(), logger })(
      { draftId },
      ctx,
    );
    await requestDraftSave(db, s.user.id, draftId, new Date());
    const gmail = fakeGmailDrafts();
    await saveDraftHandler(saveDeps(gmail.factory))({ draftId }, ctx);
    const mime = decodeRaw(gmail.calls.create[0]?.raw ?? "");
    expect(mime).toMatch(/^To: .*ada@client\.com/m);
    expect(mime).toContain("In-Reply-To: <m1@client.com>");
  });

  it("replies to the message the draft was made for, even when newer mail arrived", async () => {
    const { db } = handle;
    const s = await seed();
    const draftId = await generatedDraft(s);
    await insertMessage(db, s.thread.id, s.account.id, {
      fromAddress: { name: "Ada", address: "ada@client.com" },
      internetMessageId: "<m2@client.com>",
      sentAt: new Date(Date.now() - HOUR_MS / 2),
    });
    await requestDraftSave(db, s.user.id, draftId, new Date());
    const gmail = fakeGmailDrafts();
    await saveDraftHandler(saveDeps(gmail.factory))({ draftId }, ctx);
    const mime = decodeRaw(gmail.calls.create[0]?.raw ?? "");
    expect(mime).toContain("In-Reply-To: <m1@client.com>");
    expect(mime).not.toContain("In-Reply-To: <m2@client.com>");
  });

  it("never calls Gmail for a non-Gmail mailbox, and fails the save", async () => {
    const { db } = handle;
    const s = await seed();
    const draftId = await generatedDraft(s);
    await db
      .update(mailAccounts)
      .set({ provider: "outlook" })
      .where(eq(mailAccounts.id, s.account.id));
    await requestDraftSave(db, s.user.id, draftId, new Date());
    const gmail = fakeGmailDrafts();
    const rejection = await saveDraftHandler(saveDeps(gmail.factory))({ draftId }, ctx).catch(
      (e: unknown) => e,
    );
    expect(rejection).toBeInstanceOf(UnrecoverableError);
    expect(gmail.calls.tokens).toHaveLength(0);
    expect(gmail.calls.create).toHaveLength(0);
    expect(gmail.calls.update).toHaveLength(0);
    expect(await getDraftForWorker(db, draftId)).toMatchObject({
      status: "generated",
      saveRequestedAt: null,
      error: "internal",
    });
  });

  it("fails with no_recipient when the reply target's address is invalid", async () => {
    const { db } = handle;
    const s = await seed();
    await db
      .update(messages)
      .set({ fromAddress: { name: "Ada", address: "ada@client.com, evil@x.com" } })
      .where(eq(messages.id, s.m1.id));
    const draftId = await generatedDraft(s);
    await requestDraftSave(db, s.user.id, draftId, new Date());
    const gmail = fakeGmailDrafts();
    const rejection = await saveDraftHandler(saveDeps(gmail.factory))({ draftId }, ctx).catch(
      (e: unknown) => e,
    );
    expect(rejection).toBeInstanceOf(UnrecoverableError);
    expect((rejection as Error).message).toBe("InvalidRecipientError");
    expect(gmail.calls.create).toHaveLength(0);
    expect(await getDraftForWorker(db, draftId)).toMatchObject({
      saveRequestedAt: null,
      error: "no_recipient",
    });
  });
});

describe("auto-draft in classifyThreadHandler", () => {
  function fakeQueue() {
    const enqueued: Array<{ name: string; payload: unknown; jobId?: string }> = [];
    const queue = {
      async enqueue(name: string, payload: unknown, options?: { jobId?: string }) {
        enqueued.push({ name, payload, ...(options?.jobId ? { jobId: options.jobId } : {}) });
      },
    } as unknown as JobQueue;
    return { queue, enqueued };
  }
  const needsReply = {
    result: { urgency: 3, importance: 3, needsReply: true, reasons: ["Ada asks a question."] },
  };

  it("queues one draft for the newest message, once", async () => {
    const { db } = handle;
    const s = await seed();
    await setAutoDraft(db, s.user.id, s.account.id, true);
    await setWritingPreferences(db, s.user.id, { defaultTone: "concise" });
    const { queue, enqueued } = fakeQueue();
    const handler = classifyThreadHandler({
      db,
      encryptor,
      ai: createFakeAiProvider(needsReply),
      logger,
      queue,
    });
    await handler({ threadId: s.thread.id, messageId: s.m1.id }, ctx);

    const drafts = await db.select().from(replyDrafts).where(eq(replyDrafts.threadId, s.thread.id));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      status: "pending",
      forMessageId: s.m1.id,
      tone: "concise",
      instructions: null,
    });
    expect(enqueued).toEqual([
      {
        name: "draft.generate",
        payload: { draftId: drafts[0]?.id },
        jobId: `draft_${drafts[0]?.id}`,
      },
    ]);

    // Reclassification of the same message must not create a second draft.
    await db.delete(threadInsights).where(eq(threadInsights.threadId, s.thread.id));
    await handler({ threadId: s.thread.id, messageId: s.m1.id }, ctx);
    expect(enqueued).toHaveLength(1);
    expect(await db.select().from(replyDrafts)).toHaveLength(1);
  });

  it("queues nothing when the user replied while the classification ran", async () => {
    const { db } = handle;
    const s = await seed();
    await setAutoDraft(db, s.user.id, s.account.id, true);
    const { queue, enqueued } = fakeQueue();
    const base = createFakeAiProvider(needsReply);
    const ai = {
      ...base,
      async classify(...args: Parameters<typeof base.classify>) {
        await insertMessage(db, s.thread.id, s.account.id, {
          isFromUser: true,
          fromAddress: { name: "Me", address: "me@gmail.com" },
          sentAt: new Date(),
        });
        return base.classify(...args);
      },
    };
    await classifyThreadHandler({ db, encryptor, ai, logger, queue })(
      { threadId: s.thread.id, messageId: s.m1.id },
      ctx,
    );
    expect(base.calls).toHaveLength(1);
    expect(enqueued).toHaveLength(0);
    expect(await db.select().from(replyDrafts)).toHaveLength(0);
    expect(await db.select().from(threadInsights)).toHaveLength(0);
  });

  it("queues nothing when auto-draft is off", async () => {
    const { db } = handle;
    const s = await seed();
    const { queue, enqueued } = fakeQueue();
    await classifyThreadHandler({
      db,
      encryptor,
      ai: createFakeAiProvider(needsReply),
      logger,
      queue,
    })({ threadId: s.thread.id, messageId: s.m1.id }, ctx);
    expect(enqueued).toHaveLength(0);
    expect(await db.select().from(replyDrafts)).toHaveLength(0);
  });
});
