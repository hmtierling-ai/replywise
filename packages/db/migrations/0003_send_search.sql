-- Postgres 55P04: Drizzle applies all pending migrations in one transaction, and a new enum value
-- cannot be used in the transaction that added it. On a fresh database, a LATER migration that uses
-- 'scheduled', 'sending', 'sent' or 'send_failed' in a default, in data or in a partial-index
-- predicate would fail together with this one. Do not use them that way in future migrations, or
-- apply such a migration in a separate migrate run.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TYPE "public"."draft_status" ADD VALUE 'scheduled';--> statement-breakpoint
ALTER TYPE "public"."draft_status" ADD VALUE 'sending';--> statement-breakpoint
ALTER TYPE "public"."draft_status" ADD VALUE 'sent';--> statement-breakpoint
ALTER TYPE "public"."draft_status" ADD VALUE 'send_failed';--> statement-breakpoint
ALTER TABLE "reply_drafts" ADD COLUMN "send_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reply_drafts" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reply_drafts" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "participants_text" text GENERATED ALWAYS AS (lower(participants::text)) STORED;--> statement-breakpoint
CREATE INDEX "reply_drafts_status_send_at_idx" ON "reply_drafts" USING btree ("status","send_at");--> statement-breakpoint
CREATE INDEX "threads_provider_labels_gin_idx" ON "threads" USING gin ("provider_labels");--> statement-breakpoint
CREATE INDEX "threads_subject_trgm_idx" ON "threads" USING gin ("subject" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "threads_snippet_trgm_idx" ON "threads" USING gin ("snippet" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "threads_participants_trgm_idx" ON "threads" USING gin ("participants_text" gin_trgm_ops);