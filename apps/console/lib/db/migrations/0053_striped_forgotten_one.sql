-- Retire the CONNECTION_TEST + FETCH_RESOURCES provision_job_type values: connection verification and
-- asset inventory are server-side now (no runner job). Postgres can't drop an enum value in place, so
-- recreate the type narrowed. Existing rows of the two dropped types are deleted first so the cast to
-- the new type succeeds (they're transient audit records).
ALTER TABLE "jobs" ALTER COLUMN "job_type" SET DATA TYPE text;--> statement-breakpoint
DELETE FROM "jobs" WHERE "job_type" IN ('CONNECTION_TEST', 'FETCH_RESOURCES');--> statement-breakpoint
-- jobtype_priority_bump() takes the enum as a param → drop it before the type (programmables.sql
-- recreates it against the new type right after migrations run).
DROP FUNCTION IF EXISTS public.jobtype_priority_bump(public.provision_job_type);--> statement-breakpoint
DROP TYPE "public"."provision_job_type";--> statement-breakpoint
CREATE TYPE "public"."provision_job_type" AS ENUM('DESTROY_RUNNER', 'DEPLOY', 'DESTROY', 'PLAN', 'DEPLOY_RUNNER', 'UPDATE_RUNNER', 'ANALYZE_REPO', 'DETECT_DRIFT', 'AUDIT');--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "job_type" SET DATA TYPE "public"."provision_job_type" USING "job_type"::"public"."provision_job_type";
