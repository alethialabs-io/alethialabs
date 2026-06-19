ALTER TABLE "spec_queues" DROP COLUMN "delay_seconds";--> statement-breakpoint
ALTER TABLE "spec_queues" ADD COLUMN "provider_config" jsonb DEFAULT '{}'::jsonb;
