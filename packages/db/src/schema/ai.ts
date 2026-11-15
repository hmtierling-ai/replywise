import { DEFAULT_AI_MODELS } from "@replywise/core";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea, createdAt, updatedAt } from "../columns";
import { users } from "./auth";
import {
  aiProviderEnum,
  aiTaskEnum,
  credentialStatusEnum,
  draftStatusEnum,
  inboxCategoryEnum,
  replyToneEnum,
} from "./enums";
import { mailAccounts, messages, threads } from "./mail";

export const threadInsights = pgTable(
  "thread_insights",
  {
    threadId: uuid("thread_id")
      .primaryKey()
      .references(() => threads.id, { onDelete: "cascade" }),
    category: inboxCategoryEnum("category").notNull(),
    urgency: smallint("urgency").notNull(),
    importance: smallint("importance").notNull(),
    needsReply: boolean("needs_reply").notNull(),
    /** Plain-text explanations shown to the user. */
    reasons: jsonb("reasons").$type<string[]>().notNull(),
    summary: text("summary"),
    summaryThroughMessageId: uuid("summary_through_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    classifiedThroughMessageId: uuid("classified_through_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    aiProvider: aiProviderEnum("ai_provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("thread_insights_category_idx").on(t.category),
    check("thread_insights_urgency_range", sql`${t.urgency} between 1 and 5`),
    check("thread_insights_importance_range", sql`${t.importance} between 1 and 5`),
  ],
);

export const replyDrafts = pgTable(
  "reply_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tone: replyToneEnum("tone").notNull(),
    instructions: text("instructions"),
    /** Encrypted reply text; AAD = aad.replyDraft(id). */
    bodyCiphertext: bytea("body_ciphertext").notNull(),
    status: draftStatusEnum("status").notNull().default("generated"),
    providerDraftId: text("provider_draft_id"),
    savedAt: timestamp("saved_at", { withTimezone: true }),
    aiProvider: aiProviderEnum("ai_provider").notNull(),
    model: text("model").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("reply_drafts_thread_created_idx").on(t.threadId, t.createdAt)],
);

export const aiCredentials = pgTable(
  "ai_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: aiProviderEnum("provider").notNull(),
    /** Encrypted API key; AAD = aad.aiCredential(userId, provider). */
    keyCiphertext: bytea("key_ciphertext").notNull(),
    /** Last 4 characters, the only part ever shown to the browser. */
    keyHint: text("key_hint").notNull(),
    status: credentialStatusEnum("status").notNull().default("unverified"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("ai_credentials_user_provider_uq").on(t.userId, t.provider)],
);

export const userPreferences = pgTable(
  "user_preferences",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    defaultTone: replyToneEnum("default_tone").notNull().default("professional"),
    signature: text("signature").notNull().default(""),
    writingStyleNotes: text("writing_style_notes").notNull().default(""),
    /** null = reply in the language of the email. */
    replyLanguage: text("reply_language"),
    classificationModel: text("classification_model")
      .notNull()
      .default(DEFAULT_AI_MODELS.classification),
    generationModel: text("generation_model").notNull().default(DEFAULT_AI_MODELS.generation),
    bodyCacheDays: smallint("body_cache_days").notNull().default(14),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("user_preferences_body_cache_days_range", sql`${t.bodyCacheDays} between 1 and 30`),
  ],
);

export const aiUsageEvents = pgTable(
  "ai_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mailAccountId: uuid("mail_account_id").references(() => mailAccounts.id, {
      onDelete: "set null",
    }),
    task: aiTaskEnum("task").notNull(),
    aiProvider: aiProviderEnum("ai_provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("ai_usage_events_user_created_idx").on(t.userId, t.createdAt)],
);
