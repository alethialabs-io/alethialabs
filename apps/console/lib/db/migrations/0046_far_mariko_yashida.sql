CREATE TYPE "public"."change_op" AS ENUM('CREATE', 'UPDATE', 'DELETE');--> statement-breakpoint
CREATE TABLE "project_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"component_type" text NOT NULL,
	"component_id" uuid,
	"op" "change_op" NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_changes" ADD CONSTRAINT "project_changes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_changes" ADD CONSTRAINT "project_changes_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_changes_project" ON "project_changes" USING btree ("project_id");
