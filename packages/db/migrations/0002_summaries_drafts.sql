CREATE TYPE "public"."ai_job_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
ALTER TYPE "public"."draft_status" ADD VALUE 'pending' BEFORE 'generated';--> statement-breakpoint
ALTER TYPE "public"."draft_status" ADD VALUE 'failed';--> statement-breakpoint
CREATE TABLE "thread_summaries" (
	"thread_id" uuid PRIMARY KEY NOT NULL,
	"status" "ai_job_status" DEFAULT 'pending' NOT NULL,
	"summary" text,
	"through_message_id" uuid,
	"model" text,
	"error" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reply_drafts" ADD COLUMN "for_message_id" uuid;--> statement-breakpoint
ALTER TABLE "reply_drafts" ADD COLUMN "save_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reply_drafts" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "thread_summaries" ADD CONSTRAINT "thread_summaries_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_summaries" ADD CONSTRAINT "thread_summaries_through_message_id_messages_id_fk" FOREIGN KEY ("through_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_drafts" ADD CONSTRAINT "reply_drafts_for_message_id_messages_id_fk" FOREIGN KEY ("for_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;