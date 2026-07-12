CREATE TYPE "public"."fleet_action_type" AS ENUM('create', 'drain', 'destroy', 'noop');--> statement-breakpoint
CREATE TABLE "fleet_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" "cloud_provider" NOT NULL,
	"action" "fleet_action_type" NOT NULL,
	"runner_id" uuid,
	"count" integer DEFAULT 1 NOT NULL,
	"reason" text NOT NULL,
	"queue_depth" integer,
	"pool_size" integer,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "fleet_actions" ADD CONSTRAINT "fleet_actions_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_fleet_actions_provider_time" ON "fleet_actions" USING btree ("provider","created_at" DESC NULLS LAST);