CREATE TABLE "project_preview_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"enabled" boolean DEFAULT false NOT NULL,
	"git_provider" "git_provider" NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"apps_path" text DEFAULT '.' NOT NULL,
	"placement_mode" "placement_mode" DEFAULT 'namespace' NOT NULL,
	"fabric_id" uuid,
	"namespace_prefix" text DEFAULT 'preview' NOT NULL,
	"git_credential_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_preview_config_project_id_key" UNIQUE("project_id")
);
--> statement-breakpoint
ALTER TABLE "project_preview_config" ADD CONSTRAINT "project_preview_config_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_preview_config" ADD CONSTRAINT "project_preview_config_fabric_id_project_fabrics_id_fk" FOREIGN KEY ("fabric_id") REFERENCES "public"."project_fabrics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_preview_config" ADD CONSTRAINT "project_preview_config_git_credential_id_project_git_credentials_id_fk" FOREIGN KEY ("git_credential_id") REFERENCES "public"."project_git_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_preview_config_project" ON "project_preview_config" USING btree ("project_id");