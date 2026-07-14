CREATE TABLE "environment_cost" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"plan_job_id" uuid,
	"total_monthly" numeric(12, 2),
	"currency" text DEFAULT 'USD' NOT NULL,
	"resources" jsonb DEFAULT '[]'::jsonb,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "environment_cost" ADD CONSTRAINT "environment_cost_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_cost" ADD CONSTRAINT "environment_cost_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_cost" ADD CONSTRAINT "environment_cost_plan_job_id_jobs_id_fk" FOREIGN KEY ("plan_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_environment_cost_env_time" ON "environment_cost" USING btree ("environment_id","captured_at");