CREATE TYPE "public"."promotion_status" AS ENUM('PENDING_PLAN', 'PENDING_APPROVAL', 'APPROVED', 'DEPLOYING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "environment_protection_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"require_predecessor" boolean DEFAULT false NOT NULL,
	"require_verify_pass" boolean DEFAULT false NOT NULL,
	"require_approval" boolean DEFAULT false NOT NULL,
	"approvers" jsonb DEFAULT '{"user_ids":[],"role":null,"min_count":1}'::jsonb,
	"soak_minutes" integer,
	"cost_delta_threshold" numeric(12, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_protection_rules_env_key" UNIQUE("environment_id")
);
--> statement-breakpoint
CREATE TABLE "environment_promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"source_environment_id" uuid NOT NULL,
	"target_environment_id" uuid NOT NULL,
	"status" "promotion_status" DEFAULT 'PENDING_PLAN' NOT NULL,
	"candidate_hash" text,
	"diff_summary" jsonb,
	"gate_evaluations" jsonb,
	"plan_job_id" uuid,
	"deploy_job_id" uuid,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "promotion_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"promotion_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"org_id" uuid,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"required_role" text,
	"decided_by" uuid,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "project_environments" ADD COLUMN "auto_heal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project_environments" ADD COLUMN "last_auto_heal_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_environments" ADD COLUMN "auto_heal_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_environments" ADD COLUMN "deployed_config_hash" text;--> statement-breakpoint
ALTER TABLE "project_environments" ADD COLUMN "last_deployed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "environment_protection_rules" ADD CONSTRAINT "environment_protection_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_protection_rules" ADD CONSTRAINT "environment_protection_rules_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_promotions" ADD CONSTRAINT "environment_promotions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_promotions" ADD CONSTRAINT "environment_promotions_source_environment_id_project_environments_id_fk" FOREIGN KEY ("source_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_promotions" ADD CONSTRAINT "environment_promotions_target_environment_id_project_environments_id_fk" FOREIGN KEY ("target_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_promotions" ADD CONSTRAINT "environment_promotions_plan_job_id_jobs_id_fk" FOREIGN KEY ("plan_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_promotions" ADD CONSTRAINT "environment_promotions_deploy_job_id_jobs_id_fk" FOREIGN KEY ("deploy_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_approvals" ADD CONSTRAINT "promotion_approvals_promotion_id_environment_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."environment_promotions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_env_protection_rules_project" ON "environment_protection_rules" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_env_promotions_project" ON "environment_promotions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_env_promotions_target" ON "environment_promotions" USING btree ("target_environment_id");--> statement-breakpoint
CREATE INDEX "idx_env_promotions_plan_job" ON "environment_promotions" USING btree ("plan_job_id");--> statement-breakpoint
CREATE INDEX "idx_env_promotions_deploy_job" ON "environment_promotions" USING btree ("deploy_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "env_promotions_one_active_per_target" ON "environment_promotions" USING btree ("target_environment_id") WHERE status in ('PENDING_PLAN','PENDING_APPROVAL','APPROVED','DEPLOYING');--> statement-breakpoint
CREATE INDEX "idx_promotion_approvals_promotion" ON "promotion_approvals" USING btree ("promotion_id");
