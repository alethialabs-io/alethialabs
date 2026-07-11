ALTER TYPE "public"."provision_job_type" ADD VALUE 'IAC_SCAN';--> statement-breakpoint
CREATE TABLE "project_iac_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid,
	"name" text DEFAULT 'default' NOT NULL,
	"repo_url" text NOT NULL,
	"ref" text,
	"path" text DEFAULT '' NOT NULL,
	"commit_sha" text,
	"deployed_commit_sha" text,
	"git_credential_id" uuid,
	"var_values" jsonb DEFAULT '{}'::jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"scan_status" text DEFAULT 'unscanned' NOT NULL,
	"scan_report" jsonb,
	"scanned_at" timestamp with time zone,
	"status" "component_status" DEFAULT 'PENDING' NOT NULL,
	"status_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_iac_sources_project_id_environment_id_key" UNIQUE("project_id","environment_id")
);
--> statement-breakpoint
ALTER TABLE "project_iac_sources" ADD CONSTRAINT "project_iac_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_iac_sources" ADD CONSTRAINT "project_iac_sources_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_iac_sources" ADD CONSTRAINT "project_iac_sources_git_credential_id_project_git_credentials_id_fk" FOREIGN KEY ("git_credential_id") REFERENCES "public"."project_git_credentials"("id") ON DELETE set null ON UPDATE no action;