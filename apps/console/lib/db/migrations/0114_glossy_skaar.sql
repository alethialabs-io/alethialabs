CREATE TYPE "public"."job_initiator" AS ENUM('user', 'system', 'operator');--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD COLUMN "initiated_by" "job_initiator" DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "initiated_by" "job_initiator" DEFAULT 'system' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_jobs_user_initiated" ON "jobs" USING btree ("org_id","created_at") WHERE initiated_by = 'user';