CREATE TYPE "public"."chart_workload_kind" AS ENUM('deployment', 'statefulset', 'daemonset', 'cronjob', 'job');--> statement-breakpoint
CREATE TABLE "project_chart_workloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid,
	"addon_id" uuid NOT NULL,
	"name" text NOT NULL,
	"workload_kind" chart_workload_kind NOT NULL,
	"rendered" jsonb NOT NULL,
	"bindings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"value_paths" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_chart_workloads_project_env_addon_name_key" UNIQUE("project_id","environment_id","addon_id","name")
);
--> statement-breakpoint
ALTER TABLE "project_chart_workloads" ADD CONSTRAINT "project_chart_workloads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_chart_workloads" ADD CONSTRAINT "project_chart_workloads_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_chart_workloads" ADD CONSTRAINT "project_chart_workloads_addon_id_project_addons_id_fk" FOREIGN KEY ("addon_id") REFERENCES "public"."project_addons"("id") ON DELETE cascade ON UPDATE no action;