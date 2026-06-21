CREATE TYPE "public"."runner_operator" AS ENUM('managed', 'self');--> statement-breakpoint
CREATE TYPE "public"."runner_provisioning" AS ENUM('deployed', 'registered');--> statement-breakpoint
CREATE TABLE "runner_usage_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runner_id" uuid NOT NULL,
	"operator" "runner_operator" NOT NULL,
	"org_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_seconds" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runners" DROP CONSTRAINT "runners_mode_owner_ck";--> statement-breakpoint
DROP INDEX "idx_runners_unique_cloud_name";--> statement-breakpoint
ALTER TABLE "runners" ALTER COLUMN "mode" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "operator" "runner_operator" DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "provisioning" "runner_provisioning";--> statement-breakpoint
ALTER TABLE "runner_usage_sessions" ADD CONSTRAINT "runner_usage_sessions_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_usage_one_open_per_runner" ON "runner_usage_sessions" USING btree ("runner_id") WHERE ended_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_usage_runner_started" ON "runner_usage_sessions" USING btree ("runner_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_usage_operator_started" ON "runner_usage_sessions" USING btree ("operator","started_at") WHERE operator = 'managed';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_runners_unique_managed_name" ON "runners" USING btree ("name") WHERE operator = 'managed';