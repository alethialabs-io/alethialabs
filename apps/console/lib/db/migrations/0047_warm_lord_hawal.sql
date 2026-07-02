ALTER TABLE "project_caches" ADD COLUMN "memory_gb" numeric(8, 2);--> statement-breakpoint
ALTER TABLE "project_cluster" ADD COLUMN "node_size" jsonb;--> statement-breakpoint
ALTER TABLE "project_databases" ADD COLUMN "engine_family" text;