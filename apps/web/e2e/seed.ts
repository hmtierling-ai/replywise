import { aad, createEncryptor, LocalKeyProvider } from "@replywise/crypto";
import { aiCredentials, createDb, mailAccounts, messages, threads, users } from "@replywise/db";
import { eq } from "drizzle-orm";

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
    });
  } finally {
    await close();
  }
}
