ALTER TABLE "project_queues" ADD COLUMN "endpoint" text;--> statement-breakpoint
ALTER TABLE "project_queues" ADD COLUMN "provider_outputs" jsonb DEFAULT '{}'::jsonb;