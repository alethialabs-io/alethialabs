CREATE TYPE "public"."environment_lifecycle" AS ENUM('persistent', 'ephemeral');--> statement-breakpoint
ALTER TABLE "project_environments" ADD COLUMN "lifecycle" "environment_lifecycle" DEFAULT 'persistent' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_environments" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_environments" ADD COLUMN "cost_cap" numeric(12, 2);