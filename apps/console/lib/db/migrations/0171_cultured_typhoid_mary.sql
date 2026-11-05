ALTER TABLE "runners" ADD COLUMN "capabilities" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "last_claim_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "required_capabilities" text[] DEFAULT '{}' NOT NULL;