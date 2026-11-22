ALTER TABLE "privacy_case" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "privacy_case" ADD COLUMN "reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "privacy_case" ADD COLUMN "link_token_sha256" text;--> statement-breakpoint
CREATE INDEX "privacy_case_scheduled_idx" ON "privacy_case" USING btree ("scheduled_for");