ALTER TABLE "jobs" ADD COLUMN "plan_sha256" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_plan_sha256_hex" CHECK (plan_sha256 IS NULL OR plan_sha256 ~ '^[0-9a-f]{64}$');