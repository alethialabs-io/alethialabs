CREATE TYPE "public"."addon_mode" AS ENUM('managed', 'gitops');--> statement-breakpoint
CREATE TABLE "project_addons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid,
	"addon_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"mode" "addon_mode" DEFAULT 'managed' NOT NULL,
	"version" text,
	"values" jsonb DEFAULT '{}'::jsonb,
	"namespace" text,
	"status" "component_status" DEFAULT 'PENDING' NOT NULL,
	"status_message" text,
	"health" text,
	"sync_status" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_addons_project_id_environment_id_addon_id_key" UNIQUE("project_id","environment_id","addon_id")
);
--> statement-breakpoint
ALTER TABLE "project_addons" ADD CONSTRAINT "project_addons_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_addons" ADD CONSTRAINT "project_addons_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;