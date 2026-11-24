import {
  AI_PROVIDERS,
  AI_TASKS,
  INBOX_CATEGORIES,
  MAIL_PROVIDERS,
  REPLY_TONES,
} from "@replywise/core";
import { pgEnum } from "drizzle-orm/pg-core";

export const mailProviderEnum = pgEnum("mail_provider", MAIL_PROVIDERS);
export const mailAccountStatusEnum = pgEnum("mail_account_status", [
  "active",
  "needs_reauth",
  "error",
]);
export const inboxCategoryEnum = pgEnum("inbox_category", INBOX_CATEGORIES);
export const replyToneEnum = pgEnum("reply_tone", REPLY_TONES);
export const draftStatusEnum = pgEnum("draft_status", [
  "pending",
  "generated",
  "edited",
  "saved",
  "discarded",
  "failed",
]);
export const aiJobStatusEnum = pgEnum("ai_job_status", ["pending", "ready", "failed"]);
export const aiProviderEnum = pgEnum("ai_provider", AI_PROVIDERS);
export const aiTaskEnum = pgEnum("ai_task", AI_TASKS);
export const credentialStatusEnum = pgEnum("credential_status", ["unverified", "valid", "invalid"]);
