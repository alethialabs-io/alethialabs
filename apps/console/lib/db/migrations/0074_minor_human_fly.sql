ALTER TABLE "project_caches" ADD COLUMN "storage_gb" integer;--> statement-breakpoint
ALTER TABLE "project_databases" ADD COLUMN "storage_gb" integer;--> statement-breakpoint
ALTER TABLE "project_databases" ADD COLUMN "replicas" integer;--> statement-breakpoint
ALTER TABLE "project_queues" ADD COLUMN "storage_gb" integer;