CREATE TABLE "project_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid,
	"name" text NOT NULL,
	"cloud_identity_id" uuid,
	"region" text,
	"type" text DEFAULT 'deployment' NOT NULL,
	"source" jsonb NOT NULL,
	"build" jsonb,
	"env" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"replicas" integer DEFAULT 2 NOT NULL,
	"resources" jsonb,
	"probe" jsonb,
	"status" "component_status" DEFAULT 'PENDING' NOT NULL,
	"status_message" text,
	"estimated_monthly_cost" numeric(12, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_services_project_id_environment_id_name_key" UNIQUE("project_id","environment_id","name")
);
--> statement-breakpoint
ALTER TABLE "project_services" ADD CONSTRAINT "project_services_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_services" ADD CONSTRAINT "project_services_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_services" ADD CONSTRAINT "project_services_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE set null ON UPDATE no action;