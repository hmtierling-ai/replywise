import type { EmailAddress } from "@replywise/core";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea, createdAt, updatedAt } from "../columns";
import { users } from "./auth";
import { mailAccountStatusEnum, mailProviderEnum } from "./enums";

export const mailAccounts = pgTable(
  "mail_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: mailProviderEnum("provider").notNull(),
    emailAddress: text("email_address").notNull(),
    displayName: text("display_name"),
    status: mailAccountStatusEnum("status").notNull().default("active"),
    grantedScopes: text("granted_scopes").array().notNull().default(sql`'{}'::text[]`),
    /** Encrypted JSON {accessToken, refreshToken, expiresAt}; AAD = aad.mailTokens(id). */
    tokensCiphertext: bytea("tokens_ciphertext").notNull(),
    /** Gmail historyId or Graph deltaLink. */
    syncCursor: text("sync_cursor"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    autoDraftNeedsReply: boolean("auto_draft_needs_reply").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("mail_accounts_user_provider_email_uq").on(t.userId, t.provider, t.emailAddress),
  ],
);

export const mailOAuthStates = pgTable("mail_oauth_states", {
  /** SHA-256 of the random state sent to the provider; the raw state is never stored. */
  stateHash: text("state_hash").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  provider: mailProviderEnum("provider").notNull(),
  codeVerifierCiphertext: bytea("code_verifier_ciphertext").notNull(),
  returnTo: text("return_to").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const threads = pgTable(
  "threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mailAccountId: uuid("mail_account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    providerThreadId: text("provider_thread_id").notNull(),
    subject: text("subject").notNull().default(""),
    snippet: text("snippet").notNull().default(""),
    participants: jsonb("participants").$type<EmailAddress[]>().notNull().default(sql`'[]'::jsonb`),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull(),
    messageCount: integer("message_count").notNull().default(0),
    isUnread: boolean("is_unread").notNull().default(false),
    providerLabels: text("provider_labels").array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("threads_account_provider_thread_uq").on(t.mailAccountId, t.providerThreadId),
    index("threads_account_last_message_idx").on(t.mailAccountId, t.lastMessageAt.desc()),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    mailAccountId: uuid("mail_account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id").notNull(),
    internetMessageId: text("internet_message_id"),
    fromAddress: jsonb("from_address").$type<EmailAddress>().notNull(),
    toAddresses: jsonb("to_addresses").$type<EmailAddress[]>().notNull().default(sql`'[]'::jsonb`),
    ccAddresses: jsonb("cc_addresses").$type<EmailAddress[]>().notNull().default(sql`'[]'::jsonb`),
    subject: text("subject").notNull().default(""),
    snippet: text("snippet").notNull().default(""),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    isFromUser: boolean("is_from_user").notNull().default(false),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    /** Encrypted body cache; AAD = aad.messageBody(id). Purged at body_expires_at. */
    bodyCiphertext: bytea("body_ciphertext"),
    bodyExpiresAt: timestamp("body_expires_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("messages_account_provider_message_uq").on(t.mailAccountId, t.providerMessageId),
    index("messages_thread_sent_idx").on(t.threadId, t.sentAt),
    index("messages_body_expires_idx")
      .on(t.bodyExpiresAt)
      .where(sql`${t.bodyExpiresAt} is not null`),
  ],
);
