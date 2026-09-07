ALTER TABLE "project_caches" ADD COLUMN "provider_config" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "project_topics" ADD COLUMN "provider_config" jsonb DEFAULT '{}'::jsonb;