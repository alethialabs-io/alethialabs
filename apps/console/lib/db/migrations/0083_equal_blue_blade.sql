ALTER TABLE "project_environments" ADD COLUMN "reap_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_environments" ADD COLUMN "last_reap_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_environments" ADD COLUMN "reap_gave_up_at" timestamp with time zone;