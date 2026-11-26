import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../client";
import { replyDrafts } from "../schema/ai";
import {
  insertMailAccount,
  insertMessage,
  insertThread,
  insertUser,
  resetTestDb,
  setupTestDb,
} from "../testing";
import { discardDraft, getDraftForUser } from "./generation";
import {
  claimSend,
  clearSendAttempted,
  countRecentSends,
  expireScheduledSends,
  failSend,
  failSendBeforeAttempt,
  failStuckSends,
  getDraftMailbox,
  hasActiveSend,
  listOverdueScheduledSends,
  markSendAttempted,
  markSent,
  markSentAfterFailure,
  recordSendDraftId,
  reopenFailedSend,
  SEND_ATTEMPTED,
  SEND_DELAY_MS,
  scheduleSend,
  undoSend,
} from "./send";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

const NOW = new Date("2026-11-25T12:00:00Z");
const MIN = 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);
/** The ciphertext every test draft is inserted with (the one a confirm would have read). */
const BODY = Buffer.from("b");

async function seed(provider: "gmail" | "outlook" = "gmail") {
  const alice = await insertUser(db);
  const bob = await insertUser(db);
  const box = await insertMailAccount(db, alice.id, { provider });
  const thread = await insertThread(db, box.id, { providerLabels: ["INBOX"] });
  await insertMessage(db, thread.id, box.id);
  return { alice, bob, box, thread };
}

async function draft(
  userId: string,
  threadId: string,
  overrides: Partial<typeof replyDrafts.$inferInsert> = {},
) {
  const [row] = await db
    .insert(replyDrafts)
    .values({
      threadId,
      userId,
      tone: "professional",
      bodyCiphertext: Buffer.from("b"),
      status: "generated",
      aiProvider: "anthropic",
      model: "claude-opus-5-5",
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("draft insert failed");
  return row.id;
}

describe("scheduleSend and undoSend", () => {
  it("schedules an owned draft, undoes it back to edited, and is scoped to the owner", async () => {
    const { alice, bob, thread } = await seed();
    const id = await draft(alice.id, thread.id);
    const sendAt = at(SEND_DELAY_MS);
    expect(await scheduleSend(db, bob.id, id, BODY, sendAt, NOW)).toBe(false);
    expect(await scheduleSend(db, alice.id, id, BODY, sendAt, NOW)).toBe(true);
    expect(await getDraftForUser(db, alice.id, id)).toMatchObject({ status: "scheduled", sendAt });
    expect(await scheduleSend(db, alice.id, id, BODY, sendAt, NOW)).toBe(false); // already scheduled
    expect(await hasActiveSend(db, alice.id, thread.id)).toBe(true);
    expect(await hasActiveSend(db, bob.id, thread.id)).toBe(false);
    expect(await discardDraft(db, alice.id, id, NOW)).toBe(false);

    expect(await undoSend(db, bob.id, id, NOW)).toBeNull();
    expect(await undoSend(db, alice.id, id, NOW)).toEqual({ sendAt });
    expect((await getDraftForUser(db, alice.id, id))?.status).toBe("edited");
    expect(await undoSend(db, alice.id, id, NOW)).toBeNull(); // only from scheduled
  });

  it("refuses drafts that are not sendable", async () => {
    const { alice, thread } = await seed();
    for (const status of ["pending", "failed", "discarded", "sent", "sending"] as const) {
      const id = await draft(alice.id, thread.id, { status });
      expect(await scheduleSend(db, alice.id, id, BODY, at(SEND_DELAY_MS), NOW), status).toBe(
        false,
      );
    }
    const saving = await draft(alice.id, thread.id, { saveRequestedAt: at(-MIN) });
    expect(await scheduleSend(db, alice.id, saving, BODY, at(SEND_DELAY_MS), NOW)).toBe(false);
    const staleSave = await draft(alice.id, thread.id, { saveRequestedAt: at(-11 * MIN) });
    expect(await scheduleSend(db, alice.id, staleSave, BODY, at(SEND_DELAY_MS), NOW)).toBe(true);
  });

  it("allows a new send after a failure that proves nothing was sent, never after send_unconfirmed", async () => {
    const { alice, thread } = await seed();
    const rejected = await draft(alice.id, thread.id, {
      status: "send_failed",
      error: "send_rejected",
    });
    const saveError = await draft(alice.id, thread.id, {
      status: "send_failed",
      error: "gmail_unavailable",
    });
    const unconfirmed = await draft(alice.id, thread.id, {
      status: "send_failed",
      error: "send_unconfirmed",
    });
    expect(await scheduleSend(db, alice.id, rejected, BODY, at(SEND_DELAY_MS), NOW)).toBe(true);
    expect(await scheduleSend(db, alice.id, saveError, BODY, at(SEND_DELAY_MS), NOW)).toBe(true);
    expect(await scheduleSend(db, alice.id, unconfirmed, BODY, at(SEND_DELAY_MS), NOW)).toBe(false);
    expect(await reopenFailedSend(db, alice.id, unconfirmed, NOW)).toBe(true);
    expect(await getDraftForUser(db, alice.id, unconfirmed)).toMatchObject({
      status: "edited",
      error: null,
    });
  });

  it("refuses a body re-saved since the confirm read it, leaving the row unchanged", async () => {
    const { alice, thread } = await seed();
    const id = await draft(alice.id, thread.id, { status: "edited" });
    const before = await getDraftForUser(db, alice.id, id);
    const stale = Buffer.from("an older ciphertext");
    expect(await scheduleSend(db, alice.id, id, stale, at(SEND_DELAY_MS), NOW)).toBe(false);
    expect(await getDraftForUser(db, alice.id, id)).toEqual(before);
  });

  it("refuses non-Gmail mailboxes", async () => {
    const { alice, thread } = await seed("outlook");
    const id = await draft(alice.id, thread.id);
    expect(await scheduleSend(db, alice.id, id, BODY, at(SEND_DELAY_MS), NOW)).toBe(false);
  });
});

describe("worker transitions", () => {
  it("claims only when due, once, then records the Gmail result", async () => {
    const { alice, thread } = await seed();
    const id = await draft(alice.id, thread.id);
    await scheduleSend(db, alice.id, id, BODY, at(SEND_DELAY_MS), NOW);
    expect(await claimSend(db, id, NOW)).toBe(false); // still inside the undo window
    expect(await claimSend(db, id, at(SEND_DELAY_MS))).toBe(true);
    expect(await claimSend(db, id, at(SEND_DELAY_MS))).toBe(false);
    expect(await undoSend(db, alice.id, id, NOW)).toBeNull(); // too late to undo

    await recordSendDraftId(db, id, "r-9");
    expect(await markSendAttempted(db, id)).toBe(true);
    expect(await markSendAttempted(db, id)).toBe(false); // a second runner backs off
    expect((await getDraftForUser(db, alice.id, id))?.error).toBe(SEND_ATTEMPTED);
    await clearSendAttempted(db, id);
    expect((await getDraftForUser(db, alice.id, id))?.error).toBeNull();

    const sentAt = at(SEND_DELAY_MS + 1_000);
    expect(await markSent(db, id, "msg-1", sentAt)).toBe(true);
    expect(await getDraftForUser(db, alice.id, id)).toMatchObject({
      status: "sent",
      providerDraftId: "r-9",
      providerMessageId: "msg-1",
      sentAt,
      error: null,
    });
    expect(await failSend(db, id, "send_unconfirmed")).toBe(false); // only from sending
    expect(await discardDraft(db, alice.id, id, NOW)).toBe(false);
  });

  it("fails a sending draft with a fixed code", async () => {
    const { alice, thread } = await seed();
    const id = await draft(alice.id, thread.id, { status: "sending" });
    expect(await failSend(db, id, "send_rejected")).toBe(true);
    expect(await getDraftForUser(db, alice.id, id)).toMatchObject({
      status: "send_failed",
      error: "send_rejected",
    });
  });
});

describe("writes that must not touch an attempted send", () => {
  it("leaves a marked row alone when a losing run fails or repoints it before the send call", async () => {
    const { alice, thread } = await seed();
    const id = await draft(alice.id, thread.id, {
      status: "sending",
      error: SEND_ATTEMPTED,
      providerDraftId: "r-1",
    });
    expect(await failSendBeforeAttempt(db, id, "gmail_unavailable")).toBe(false);
    await recordSendDraftId(db, id, "r-2");
    expect(await getDraftForUser(db, alice.id, id)).toMatchObject({
      status: "sending",
      error: SEND_ATTEMPTED,
      providerDraftId: "r-1",
    });

    const fresh = await draft(alice.id, thread.id, { status: "sending" });
    await recordSendDraftId(db, fresh, "r-3");
    expect(await failSendBeforeAttempt(db, fresh, "gmail_reauth")).toBe(true);
    expect(await getDraftForUser(db, alice.id, fresh)).toMatchObject({
      status: "send_failed",
      error: "gmail_reauth",
      providerDraftId: "r-3",
    });
  });

  it("records a confirmed send over a failure written meanwhile, never over a new send", async () => {
    const { alice, thread } = await seed();
    const sentAt = at(1_000);
    const failed = await draft(alice.id, thread.id, {
      status: "send_failed",
      error: "gmail_unavailable",
    });
    expect(await markSentAfterFailure(db, failed, "msg-1", sentAt)).toBe(true);
    expect(await getDraftForUser(db, alice.id, failed)).toMatchObject({
      status: "sent",
      providerMessageId: "msg-1",
      sentAt,
      error: null,
    });
    for (const status of ["scheduled", "sending", "edited"] as const) {
      const other = await draft(alice.id, thread.id, { status });
      expect(await markSentAfterFailure(db, other, "msg-2", sentAt)).toBe(false);
      expect((await getDraftForUser(db, alice.id, other))?.status).toBe(status);
    }
  });
});

describe("limits, mailbox lookup and stuck sends", () => {
  it("counts sent drafts of the last hour plus scheduled and sending ones, per user", async () => {
    const { alice, bob, thread } = await seed();
    await draft(alice.id, thread.id, { status: "sent", sentAt: at(-30 * MIN) });
    await draft(alice.id, thread.id, { status: "sent", sentAt: at(-61 * MIN) });
    await draft(alice.id, thread.id, { status: "scheduled", sendAt: at(5_000) });
    await draft(alice.id, thread.id, { status: "sending" });
    await draft(alice.id, thread.id, { status: "edited" });
    expect(await countRecentSends(db, alice.id, NOW)).toBe(3);
    expect(await countRecentSends(db, bob.id, NOW)).toBe(0);
  });

  it("returns the draft's thread and mailbox only to its owner", async () => {
    const { alice, bob, box, thread } = await seed();
    const id = await draft(alice.id, thread.id);
    expect(await getDraftMailbox(db, alice.id, id)).toEqual({
      threadId: thread.id,
      mailAccountId: box.id,
      provider: "gmail",
    });
    expect(await getDraftMailbox(db, bob.id, id)).toBeNull();
  });

  it("finds overdue scheduled sends, expires very old ones and fails stuck sending ones", async () => {
    const { alice, box, thread } = await seed();
    const onTime = await draft(alice.id, thread.id, { status: "scheduled", sendAt: at(-30_000) });
    const overdue = await draft(alice.id, thread.id, { status: "scheduled", sendAt: at(-2 * MIN) });
    const ancient = await draft(alice.id, thread.id, {
      status: "scheduled",
      sendAt: at(-11 * MIN),
    });
    const stuck = await draft(alice.id, thread.id, { status: "sending", updatedAt: at(-11 * MIN) });
    const active = await draft(alice.id, thread.id, { status: "sending", updatedAt: at(-MIN) });

    expect(await listOverdueScheduledSends(db, NOW)).toEqual([
      { draftId: overdue, sendAt: at(-2 * MIN) },
    ]);
    expect(await expireScheduledSends(db, NOW)).toEqual([
      {
        draftId: ancient,
        userId: alice.id,
        threadId: thread.id,
        mailAccountId: box.id,
        error: "internal",
      },
    ]);
    expect(await failStuckSends(db, NOW)).toEqual([
      {
        draftId: stuck,
        userId: alice.id,
        threadId: thread.id,
        mailAccountId: box.id,
        error: "send_unconfirmed",
      },
    ]);
    expect((await getDraftForUser(db, alice.id, onTime))?.status).toBe("scheduled");
    expect((await getDraftForUser(db, alice.id, active))?.status).toBe("sending");
    expect(await getDraftForUser(db, alice.id, ancient)).toMatchObject({
      status: "send_failed",
      error: "internal",
    });
  });
});
