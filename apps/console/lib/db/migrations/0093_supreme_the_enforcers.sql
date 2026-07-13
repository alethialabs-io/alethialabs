ALTER TYPE "public"."provision_job_type" ADD VALUE 'PROBE_CLUSTER';--> statement-breakpoint
CREATE TABLE "environment_probes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"reachable" boolean NOT NULL,
	"message" text,
	"detail" jsonb DEFAULT '{}'::jsonb,
	"probed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "environment_probes" ADD CONSTRAINT "environment_probes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_probes" ADD CONSTRAINT "environment_probes_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_environment_probes_env_time" ON "environment_probes" USING btree ("environment_id","probed_at" DESC NULLS LAST);