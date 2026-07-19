CREATE TYPE "public"."placement_mode" AS ENUM('namespace', 'vcluster', 'dedicated');--> statement-breakpoint
CREATE TABLE "project_fabrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"name" text NOT NULL,
	"cloud_identity_id" uuid,
	"region" text,
	"status" "project_status" DEFAULT 'DRAFT' NOT NULL,
	"status_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_fabrics_project_id_name_key" UNIQUE("project_id","name")
);
--> statement-breakpoint
ALTER TABLE "project_cluster" ADD COLUMN "fabric_id" uuid;--> statement-breakpoint
ALTER TABLE "project_environments" ADD COLUMN "fabric_id" uuid;--> statement-breakpoint
ALTER TABLE "project_environments" ADD COLUMN "placement_mode" "placement_mode" DEFAULT 'dedicated' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_environments" ADD COLUMN "namespace" text;--> statement-breakpoint
ALTER TABLE "project_fabrics" ADD CONSTRAINT "project_fabrics_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_fabrics" ADD CONSTRAINT "project_fabrics_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_fabrics_project" ON "project_fabrics" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "project_cluster" ADD CONSTRAINT "project_cluster_fabric_id_project_fabrics_id_fk" FOREIGN KEY ("fabric_id") REFERENCES "public"."project_fabrics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_environments" ADD CONSTRAINT "project_environments_fabric_id_project_fabrics_id_fk" FOREIGN KEY ("fabric_id") REFERENCES "public"."project_fabrics"("id") ON DELETE set null ON UPDATE no action;