ALTER TYPE "public"."provision_job_type" RENAME VALUE 'DESTROY_WORKER' TO 'DESTROY_RUNNER';--> statement-breakpoint
ALTER TYPE "public"."provision_job_type" RENAME VALUE 'DEPLOY_WORKER' TO 'DEPLOY_RUNNER';--> statement-breakpoint
ALTER TYPE "public"."provision_job_type" RENAME VALUE 'UPDATE_WORKER' TO 'UPDATE_RUNNER';--> statement-breakpoint
ALTER TYPE "public"."worker_mode" RENAME TO "runner_mode";--> statement-breakpoint
ALTER TYPE "public"."worker_status" RENAME TO "runner_status";
