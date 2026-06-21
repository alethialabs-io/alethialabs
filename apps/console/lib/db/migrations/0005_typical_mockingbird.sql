DROP INDEX "idx_jobs_queue";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "priority" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "provider" "cloud_provider";--> statement-breakpoint
CREATE INDEX "idx_jobs_queue" ON "jobs" USING btree ("status","priority" DESC NULLS LAST,"created_at") WHERE status = 'QUEUED';