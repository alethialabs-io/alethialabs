ALTER TABLE "job_logs" ADD COLUMN "traceparent" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "traceparent" text;