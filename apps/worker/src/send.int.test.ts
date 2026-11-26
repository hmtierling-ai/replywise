import { aad } from "@replywise/crypto";
import {
  auditLogs,
  getDraftForWorker,
  mailAccounts,
  messages,
  replyDrafts,
  SEND_ATTEMPTED,
  scheduleSend,
  threadInsights,
  undoSend,
} from "@replywise/db";
import {
  insertMailAccount,
  insertMessage,
  insertThread,
  insertUser,
  resetTestDb,
  setupTestDb,
} from "@replywise/db/testing";
import { type GmailDraftsFactory, type GmailSendFactory, ProviderHttpError } from "@replywise/mail";
import { createFakeProvider, testEncryptor } from "@replywise/mailbox/testing";
import { createLogger } from "@replywise/observability";
import { type JobQueue, sendJobId } from "@replywise/queue";
import { UnrecoverableError } from "bullmq";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recoverSendsHandler } from "./jobs/recover-sends";
import { sendDraftHandler } from "./jobs/send-draft";

let handle: Awaited<ReturnType<typeof setupTestDb>>;
const encryptor = testEncryptor();
const logger = createLogger({ name: "test", level: "silent" });
const first = { jobId: "t", attempt: 1 };
const second = { jobId: "t", attempt: 2 };
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;
const BODY = "Hi Ada,\n\nSigned and attached.";
const rateLimited = () => new ProviderHttpError(429, "/gmail/v1/users/me/drafts", true);

beforeAll(async () => {
  handle = await setupTestDb();
});
afterAll(async () => handle.close());
beforeEach(async () => resetTestDb(handle.db));

async function seed(options: { providerDraftId?: string } = {}) {
  const { db } = handle;
  const user = await insertUser(db, { name: "Me" });
  const account = await insertMailAccount(db, user.id, { emailAddress: "me@gmail.com" });
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
  });
  const m1 = await insertMessage(db, thread.id, account.id, {
    fromAddress: { name: "Ada", address: "ada@client.com" },
    internetMessageId: "<m1@client.com>",
    sentAt: new Date(Date.now() - HOUR_MS),
  });
  await db.insert(threadInsights).values({
    threadId: thread.id,
    category: "needs_reply",
    urgency: 3,
    importance: 3,
    needsReply: true,
    reasons: ["Ada asks."],
    classifiedThroughMessageId: m1.id,
    aiProvider: "anthropic",
    model: "claude-opus-5-5",
    promptVersion: "classify-v1",
  });
  const [draft] = await db
    .insert(replyDrafts)
    .values({
      threadId: thread.id,
      userId: user.id,
      tone: "professional",
      bodyCiphertext: Buffer.from("placeholder"),
      status: "edited",
      forMessageId: m1.id,
      providerDraftId: options.providerDraftId ?? null,
      aiProvider: "anthropic",
      model: "claude-opus-5-5",
    })
    .returning();
  if (!draft) throw new Error("draft insert failed");
  const ciphertext = await encryptor.encrypt(BODY, aad.replyDraft(draft.id));
  await db
    .update(replyDrafts)
    .set({ bodyCiphertext: ciphertext })
    .where(eq(replyDrafts.id, draft.id));
  // Already past the undo window, so the claim succeeds immediately.
  const sendAt = new Date(Date.now() - 1_000);
  expect(await scheduleSend(db, user.id, draft.id, ciphertext, sendAt, new Date())).toBe(true);
  return { user, account, thread, m1, draftId: draft.id, sendAt };
}

function fakeDrafts(errors: Error[] = []) {
  const calls = { create: 0, update: [] as string[] };
  const factory: GmailDraftsFactory = () => ({
    async createDraft() {
      calls.create += 1;
      const error = errors.shift();
      if (error) throw error;
      return { draftId: "r-1" };
    },
    async updateDraft(id) {
      calls.update.push(id);
      const error = errors.shift();
      if (error) throw error;
      return { draftId: id };
    },
  });
  return { factory, calls };
}

function fakeSender(results: Array<Error | string> = []) {
  const calls: string[] = [];
  const factory: GmailSendFactory = () => ({
    async sendDraft(providerDraftId) {
      calls.push(providerDraftId);
      const next = results.shift() ?? "msg-1";
      if (next instanceof Error) throw next;
      return { messageId: next, threadId: "gmail-thread" };
    },
  });
  return { factory, calls };
}

function fakeQueue() {
  const jobs: Array<{ name: string; payload: unknown; jobId?: string }> = [];
  const queue = {
    async enqueue(name: string, payload: unknown, options?: { jobId?: string }) {
      jobs.push({ name, payload, ...(options?.jobId ? { jobId: options.jobId } : {}) });
    },
  } as unknown as JobQueue;
  return { queue, jobs };
}

function handler(
  drafts: ReturnType<typeof fakeDrafts>,
  sender: ReturnType<typeof fakeSender>,
  queue = fakeQueue().queue,
) {
  const { db } = handle;
  return sendDraftHandler({
    db,
    encryptor,
    logger,
    queue,
    gmailDrafts: drafts.factory,
    gmailSend: sender.factory,
    mailbox: { db, encryptor, providers: { gmail: createFakeProvider("gmail").provider } },
  });
}

async function auditActions() {
  return handle.db.select().from(auditLogs);
}

describe("sendDraftHandler", () => {
  it("writes the Gmail draft, sends it once and records the result", async () => {
    const s = await seed();
    const drafts = fakeDrafts();
    const sender = fakeSender();
    const { queue, jobs } = fakeQueue();
    const run = handler(drafts, sender, queue);
    await run({ draftId: s.draftId }, first);

    expect(drafts.calls.create).toBe(1);
    expect(sender.calls).toEqual(["r-1"]);
    const row = await getDraftForWorker(handle.db, s.draftId);
    expect(row).toMatchObject({
      status: "sent",
      providerDraftId: "r-1",
      providerMessageId: "msg-1",
      error: null,
    });
    expect(row?.sentAt).toBeInstanceOf(Date);
    const [insight] = await handle.db
      .select()
      .from(threadInsights)
      .where(eq(threadInsights.threadId, s.thread.id));
    expect(insight?.needsReply).toBe(false);
    const audit = await auditActions();
    expect(audit.map((a) => a.action)).toEqual(["draft.sent"]);
    expect(audit[0]?.metadata).toEqual({
      draftId: s.draftId,
      threadId: s.thread.id,
      mailAccountId: s.account.id,
    });
    expect(JSON.stringify(audit)).not.toContain("Signed");
    expect(jobs).toEqual([
      {
        name: "mailbox.sync",
        payload: { mailAccountId: s.account.id },
        jobId: `sync_after_send_${s.draftId}`,
      },
    ]);

    await run({ draftId: s.draftId }, second); // a duplicate run is a no-op
    expect(sender.calls).toHaveLength(1);
  });

  it("does nothing when the send was undone before the job ran", async () => {
    const s = await seed();
    await undoSend(handle.db, s.user.id, s.draftId, new Date());
    const drafts = fakeDrafts();
    const sender = fakeSender();
    await handler(drafts, sender)({ draftId: s.draftId }, first);
    expect(drafts.calls.create).toBe(0);
    expect(sender.calls).toEqual([]);
    expect((await getDraftForWorker(handle.db, s.draftId))?.status).toBe("edited");
  });

  it("updates the existing Gmail draft before sending it", async () => {
    const s = await seed({ providerDraftId: "r-0" });
    const drafts = fakeDrafts();
    const sender = fakeSender();
    await handler(drafts, sender)({ draftId: s.draftId }, first);
    expect(drafts.calls).toEqual({ create: 0, update: ["r-0"] });
    expect(sender.calls).toEqual(["r-0"]);
  });

  it("retries a rate limit before the send call and then sends once", async () => {
    const s = await seed();
    const drafts = fakeDrafts([rateLimited()]);
    const sender = fakeSender();
    const run = handler(drafts, sender);
    await expect(run({ draftId: s.draftId }, first)).rejects.toBeInstanceOf(ProviderHttpError);
    expect(await getDraftForWorker(handle.db, s.draftId)).toMatchObject({
      status: "sending",
      error: null,
    });
    expect(sender.calls).toEqual([]);
    await run({ draftId: s.draftId }, second);
    expect(sender.calls).toEqual(["r-1"]);
    expect((await getDraftForWorker(handle.db, s.draftId))?.status).toBe("sent");
  });

  it("retries a rate-limited send call, which Gmail did not process", async () => {
    const s = await seed();
    const sender = fakeSender([rateLimited(), "msg-2"]);
    const run = handler(fakeDrafts(), sender);
    await expect(run({ draftId: s.draftId }, first)).rejects.toBeInstanceOf(ProviderHttpError);
    expect(await getDraftForWorker(handle.db, s.draftId)).toMatchObject({
      status: "sending",
      error: null,
    });
    await run({ draftId: s.draftId }, second);
    expect(sender.calls).toEqual(["r-1", "r-1"]);
    expect(await getDraftForWorker(handle.db, s.draftId)).toMatchObject({
      status: "sent",
      providerMessageId: "msg-2",
    });
  });

  it("never retries an ambiguous send failure", async () => {
    const s = await seed();
    const sender = fakeSender([new ProviderHttpError(503, "/x")]);
    const run = handler(fakeDrafts(), sender);
    await expect(run({ draftId: s.draftId }, first)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await getDraftForWorker(handle.db, s.draftId)).toMatchObject({
      status: "send_failed",
      error: "send_unconfirmed",
    });
    const audit = await auditActions();
    expect(audit.map((a) => [a.action, a.metadata.error])).toEqual([
      ["draft.send_failed", "send_unconfirmed"],
    ]);
    await run({ draftId: s.draftId }, second);
    expect(sender.calls).toHaveLength(1);
  });

  it("maps a timeout to send_unconfirmed and a 4xx to send_rejected", async () => {
    const timedOut = await seed();
    await expect(
      handler(fakeDrafts(), fakeSender([new ProviderHttpError(0, "/x")]))(
        { draftId: timedOut.draftId },
        first,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await getDraftForWorker(handle.db, timedOut.draftId))?.error).toBe("send_unconfirmed");

    await resetTestDb(handle.db);
    const rejected = await seed();
    await expect(
      handler(fakeDrafts(), fakeSender([new ProviderHttpError(400, "/x")]))(
        { draftId: rejected.draftId },
        first,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await getDraftForWorker(handle.db, rejected.draftId))?.error).toBe("send_rejected");
  });

  it("fails without sending when the Gmail draft cannot be written", async () => {
    const s = await seed();
    const sender = fakeSender();
    await expect(
      handler(fakeDrafts([new ProviderHttpError(500, "/x")]), sender)(
        { draftId: s.draftId },
        first,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await getDraftForWorker(handle.db, s.draftId)).toMatchObject({
      status: "send_failed",
      error: "gmail_unavailable",
    });
    expect(sender.calls).toEqual([]);
  });

  it("never repeats a send call that may already have happened", async () => {
    const s = await seed();
    await handle.db
      .update(replyDrafts)
      .set({ status: "sending", error: SEND_ATTEMPTED })
      .where(eq(replyDrafts.id, s.draftId));
    const drafts = fakeDrafts();
    const sender = fakeSender();
    await handler(drafts, sender)({ draftId: s.draftId }, second);
    expect(drafts.calls.create).toBe(0);
    expect(sender.calls).toEqual([]);
    expect((await getDraftForWorker(handle.db, s.draftId))?.status).toBe("sending");
  });

  it("never fails a send another run already attempted when its own draft write fails", async () => {
    const s = await seed();
    // Run B passed its checks; run A marks the attempt while B writes the Gmail draft, then B's
    // write fails.
    const factory: GmailDraftsFactory = () => ({
      async createDraft() {
        await handle.db
          .update(replyDrafts)
          .set({ error: SEND_ATTEMPTED })
          .where(eq(replyDrafts.id, s.draftId));
        throw new ProviderHttpError(500, "/x");
      },
      async updateDraft() {
        throw new Error("unexpected");
      },
    });
    const sender = fakeSender();
    await expect(
      handler({ factory, calls: { create: 0, update: [] } }, sender)({ draftId: s.draftId }, first),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await getDraftForWorker(handle.db, s.draftId)).toMatchObject({
      status: "sending",
      error: SEND_ATTEMPTED,
      providerDraftId: null,
    });
    expect(sender.calls).toEqual([]);
    expect(await auditActions()).toEqual([]);
  });

  it("records a confirmed send even when the row was failed while the call ran", async () => {
    const s = await seed();
    const factory: GmailSendFactory = () => ({
      async sendDraft() {
        await handle.db
          .update(replyDrafts)
          .set({ status: "send_failed", error: "gmail_unavailable" })
          .where(eq(replyDrafts.id, s.draftId));
        return { messageId: "msg-9", threadId: "gmail-thread" };
      },
    });
    await handler(fakeDrafts(), { factory, calls: [] })({ draftId: s.draftId }, first);
    expect(await getDraftForWorker(handle.db, s.draftId)).toMatchObject({
      status: "sent",
      providerMessageId: "msg-9",
      error: null,
    });
    expect((await auditActions()).map((a) => a.action)).toEqual(["draft.sent"]);
  });

  it("fails with no_recipient when nobody else wrote in the thread", async () => {
    const s = await seed();
    await handle.db
      .update(replyDrafts)
      .set({ forMessageId: null })
      .where(eq(replyDrafts.id, s.draftId));
    await handle.db.update(messages).set({ isFromUser: true }).where(eq(messages.id, s.m1.id));
    const sender = fakeSender();
    await expect(
      handler(fakeDrafts(), sender)({ draftId: s.draftId }, first),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await getDraftForWorker(handle.db, s.draftId))?.error).toBe("no_recipient");
    expect(sender.calls).toEqual([]);
  });
});

describe("recoverSendsHandler", () => {
  it("re-enqueues lost scheduled sends with their job id and fails stuck ones", async () => {
    const s = await seed();
    const now = new Date();
    const lostAt = new Date(now.getTime() - 2 * MIN_MS);
    await handle.db
      .update(replyDrafts)
      .set({ sendAt: lostAt })
      .where(eq(replyDrafts.id, s.draftId));
    const [stuck] = await handle.db
      .insert(replyDrafts)
      .values({
        threadId: s.thread.id,
        userId: s.user.id,
        tone: "professional",
        bodyCiphertext: Buffer.from("x"),
        status: "sending",
        aiProvider: "anthropic",
        model: "claude-opus-5-5",
        updatedAt: new Date(now.getTime() - 11 * MIN_MS),
      })
      .returning();
    const { queue, jobs } = fakeQueue();
    await recoverSendsHandler({ db: handle.db, queue, logger, now: () => now })();
    expect(jobs).toEqual([
      { name: "draft.send", payload: { draftId: s.draftId }, jobId: sendJobId(s.draftId, lostAt) },
    ]);
    expect(await getDraftForWorker(handle.db, stuck?.id ?? "")).toMatchObject({
      status: "send_failed",
      error: "send_unconfirmed",
    });
    expect((await auditActions()).map((a) => [a.action, a.metadata.error])).toEqual([
      ["draft.send_failed", "send_unconfirmed"],
    ]);
  });
});
