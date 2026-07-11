ALTER TABLE "project_addons" ADD COLUMN "source" text DEFAULT 'catalog' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_addons" ADD COLUMN "chart_path" text;--> statement-breakpoint
ALTER TABLE "project_addons" ADD COLUMN "chart_repo" text;--> statement-breakpoint
ALTER TABLE "project_addons" ADD COLUMN "git_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "project_addons" ADD CONSTRAINT "project_addons_git_credential_id_project_git_credentials_id_fk" FOREIGN KEY ("git_credential_id") REFERENCES "public"."project_git_credentials"("id") ON DELETE set null ON UPDATE no action;