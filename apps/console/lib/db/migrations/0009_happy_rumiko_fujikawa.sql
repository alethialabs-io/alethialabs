ALTER TABLE "jobs" ADD COLUMN "usage_reported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "current_period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "usage_hard_cap" boolean DEFAULT false NOT NULL;