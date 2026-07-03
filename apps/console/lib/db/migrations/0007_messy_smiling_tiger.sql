ALTER TABLE "runners" ADD COLUMN "supported_providers" "cloud_provider"[];--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;