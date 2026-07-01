CREATE TABLE "project_source_repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid,
	"repo_url" text NOT NULL,
	"ref" text,
	"scan_path" text DEFAULT '' NOT NULL,
	"services" jsonb DEFAULT '[]'::jsonb,
	"git_credential_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_source_repos_project_env_repo_path_key" UNIQUE("project_id","environment_id","repo_url","scan_path")
);
--> statement-breakpoint
ALTER TABLE "project_source_repos" ADD CONSTRAINT "project_source_repos_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_source_repos" ADD CONSTRAINT "project_source_repos_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;
