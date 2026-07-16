ALTER TYPE "public"."provision_job_type" ADD VALUE 'BUILD';--> statement-breakpoint
ALTER TABLE "project_services" ADD COLUMN "resolved_image" text;