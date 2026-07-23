CREATE TABLE "project_helm_registries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid,
	"name" text NOT NULL,
	"cloud_identity_id" uuid,
	"region" text,
	"provider" text,
	"provider_config" jsonb DEFAULT '{}'::jsonb,
	"status" "component_status" DEFAULT 'PENDING' NOT NULL,
	"status_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_helm_registries_project_id_environment_id_name_key" UNIQUE("project_id","environment_id","name")
);
--> statement-breakpoint
ALTER TABLE "project_helm_registries" ADD CONSTRAINT "project_helm_registries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_helm_registries" ADD CONSTRAINT "project_helm_registries_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_helm_registries" ADD CONSTRAINT "project_helm_registries_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE set null ON UPDATE no action;