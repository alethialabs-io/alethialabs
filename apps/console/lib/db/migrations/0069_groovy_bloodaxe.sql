CREATE TABLE "tofu_state_locks" (
	"state_key" text PRIMARY KEY NOT NULL,
	"lock_id" text NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL,
	"job_id" uuid,
	"info" jsonb NOT NULL,
	"locked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tofu_state_locks" ADD CONSTRAINT "tofu_state_locks_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;