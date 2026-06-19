ALTER TABLE "spec_storage_buckets" DROP COLUMN "encryption";--> statement-breakpoint
ALTER TABLE "spec_storage_buckets" ADD COLUMN "encryption_enabled" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "spec_storage_buckets" ADD COLUMN "provider_config" jsonb DEFAULT '{}'::jsonb;
