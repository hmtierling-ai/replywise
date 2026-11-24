import type { InboxCategory } from "@replywise/core";
import { aad, createEncryptor, LocalKeyProvider } from "@replywise/crypto";
import {
  aiCredentials,
  createDb,
  mailAccounts,
  messages,
  replyDrafts,
  threadInsights,
  threadSummaries,
  threads,
  users,
} from "@replywise/db";
import { desc, eq } from "drizzle-orm";

/** Direct DB seeding for e2e. Uses the same DATABASE_URL and LOCAL_KEKS as the server. */
export async function withSeed<T>(
  fn: (seed: {
    aiKey: (
      userEmail: string,
      input?: { hint?: string; status?: "valid" | "invalid" },
    ) => Promise<void>;
    mailbox: (
      userEmail: string,
      overrides?: Partial<typeof mailAccounts.$inferInsert>,
    ) => Promise<string>;
    thread: (
      mailAccountId: string,
      input: {
        subject: string;
        snippet: string;
        unread?: boolean;
        html?: string;
        text?: string;
        from?: string;
        at?: Date;
      },
    ) => Promise<string>;
    insight: (
      threadId: string,
      input: {
        category: InboxCategory;
        reasons: string[];
        urgency?: number;
        importance?: number;
        needsReply?: boolean;
      },
    ) => Promise<void>;
    summary: (
      threadId: string,
      input: { status: "pending" | "ready" | "failed"; text?: string; error?: string },
    ) => Promise<void>;
    draft: (
      userEmail: string,
      threadId: string,
      input: {
        status: "pending" | "generated" | "edited" | "saved" | "failed";
        body?: string;
        error?: string;
        providerDraftId?: string;
        savedAt?: Date;
        saveRequestedAt?: Date;
      },
    ) => Promise<string>;
  }) => Promise<T>,
): Promise<T> {
  const url = process.env.DATABASE_URL;
  const keks = process.env.LOCAL_KEKS;
  if (!url || !keks) throw new Error("DATABASE_URL and LOCAL_KEKS must be set for e2e seeding");
  const { db, close } = createDb(url, { max: 1 });
  const encryptor = createEncryptor(LocalKeyProvider.fromEnv(keks));
  try {
    return await fn({
      async aiKey(userEmail, input) {
        const [user] = await db.select().from(users).where(eq(users.email, userEmail));
        if (!user) throw new Error(`no user ${userEmail}`);
        await db.insert(aiCredentials).values({
          userId: user.id,
          provider: "anthropic",
          keyCiphertext: await encryptor.encrypt(
            `sk-ant-e2e-${"x".repeat(30)}`,
            aad.aiCredential(user.id, "anthropic"),
          ),
          keyHint: input?.hint ?? "e2e1",
          status: input?.status ?? "valid",
          lastValidatedAt: new Date(),
        });
      },
      async mailbox(userEmail, overrides = {}) {
        const [user] = await db.select().from(users).where(eq(users.email, userEmail));
        if (!user) throw new Error(`no user ${userEmail}`);
        const [row] = await db
          .insert(mailAccounts)
          .values({
            userId: user.id,
            provider: "gmail",
            emailAddress: `seed-${Date.now()}@gmail.com`,
            tokensCiphertext: Buffer.from("seed"),
            ...overrides,
          })
          .returning({ id: mailAccounts.id });
        if (!row) throw new Error("seed mailbox failed");
        return row.id;
      },
      async thread(mailAccountId, input) {
        const sentAt = input.at ?? new Date();
        const from = input.from ?? "ada@example.com";
        const [thread] = await db
          .insert(threads)
          .values({
            mailAccountId,
            providerThreadId: `seed-${Math.random().toString(36).slice(2)}`,
            subject: input.subject,
            snippet: input.snippet,
            participants: [{ name: "Ada Lovelace", address: from }],
            lastMessageAt: sentAt,
            messageCount: 1,
            isUnread: input.unread ?? false,
            providerLabels: input.unread ? ["INBOX", "UNREAD"] : ["INBOX"],
          })
          .returning({ id: threads.id });
        if (!thread) throw new Error("seed thread failed");
        const [message] = await db
          .insert(messages)
          .values({
            threadId: thread.id,
            mailAccountId,
            providerMessageId: `seed-${Math.random().toString(36).slice(2)}`,
            fromAddress: { name: "Ada Lovelace", address: from },
            subject: input.subject,
            snippet: input.snippet,
            sentAt,
          })
          .returning({ id: messages.id });
        if (!message) throw new Error("seed message failed");
        if (input.html !== undefined || input.text !== undefined) {
          const body = await encryptor.encrypt(
            JSON.stringify({ text: input.text ?? null, html: input.html ?? null }),
            aad.messageBody(message.id),
          );
          await db
            .update(messages)
            .set({ bodyCiphertext: body, bodyExpiresAt: new Date(Date.now() + 86_400_000) })
            .where(eq(messages.id, message.id));
        }
        return thread.id;
      },
      async insight(threadId, input) {
        const [latest] = await db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.threadId, threadId))
          .orderBy(desc(messages.sentAt))
          .limit(1);
        if (!latest) throw new Error(`no messages for thread ${threadId}`);
        await db.insert(threadInsights).values({
          threadId,
          category: input.category,
          urgency: input.urgency ?? 3,
          importance: input.importance ?? 3,
          needsReply: input.needsReply ?? false,
          reasons: input.reasons,
          classifiedThroughMessageId: latest.id,
          aiProvider: "anthropic",
          model: "claude-opus-5-5",
          promptVersion: "classify-v1",
        });
      },
      async summary(threadId, input) {
        const [latest] = await db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.threadId, threadId))
          .orderBy(desc(messages.sentAt))
          .limit(1);
        if (!latest) throw new Error(`no messages for thread ${threadId}`);
        const values = {
          status: input.status,
          summary: input.text ?? null,
          throughMessageId: input.status === "ready" ? latest.id : null,
          model: "claude-opus-5-5",
          error: input.error ?? null,
          requestedAt: new Date(),
        };
        await db
          .insert(threadSummaries)
          .values({ threadId, ...values })
          .onConflictDoUpdate({ target: threadSummaries.threadId, set: values });
      },
      async draft(userEmail, threadId, input) {
        const [user] = await db.select().from(users).where(eq(users.email, userEmail));
        if (!user) throw new Error(`no user ${userEmail}`);
        const [latest] = await db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.threadId, threadId))
          .orderBy(desc(messages.sentAt))
          .limit(1);
        const [row] = await db
          .insert(replyDrafts)
          .values({
            threadId,
            userId: user.id,
            tone: "professional",
            bodyCiphertext: Buffer.from("placeholder"),
            status: input.status,
            forMessageId: latest?.id ?? null,
            error: input.error ?? null,
            providerDraftId: input.providerDraftId ?? null,
            savedAt: input.savedAt ?? null,
            saveRequestedAt: input.saveRequestedAt ?? null,
            aiProvider: "anthropic",
            model: "claude-opus-5-5",
          })
          .returning({ id: replyDrafts.id });
        if (!row) throw new Error("seed draft failed");
        if (input.body !== undefined) {
          await db
            .update(replyDrafts)
            .set({ bodyCiphertext: await encryptor.encrypt(input.body, aad.replyDraft(row.id)) })
            .where(eq(replyDrafts.id, row.id));
        }
        return row.id;
      },
    });
  } finally {
    await close();
  }
}
