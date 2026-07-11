ALTER TYPE "public"."provision_job_type" ADD VALUE 'CHART_SCAN';--> statement-breakpoint
ALTER TABLE "project_addons" ADD COLUMN "scan_status" text DEFAULT 'unscanned' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_addons" ADD COLUMN "scan_report" jsonb;--> statement-breakpoint
ALTER TABLE "project_addons" ADD COLUMN "scanned_at" timestamp with time zone;