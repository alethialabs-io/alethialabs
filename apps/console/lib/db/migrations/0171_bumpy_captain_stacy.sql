ALTER TABLE "runners" ADD COLUMN "capabilities" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "required_capabilities" text[] DEFAULT '{}' NOT NULL;