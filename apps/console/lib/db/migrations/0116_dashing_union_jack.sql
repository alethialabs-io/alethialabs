CREATE TABLE "fabric_drift" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"fabric_id" uuid NOT NULL,
	"in_sync" boolean NOT NULL,
	"drifted" integer DEFAULT 0 NOT NULL,
	"details" jsonb DEFAULT '[]'::jsonb,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fabric_drift_project_id_fabric_id_key" UNIQUE("project_id","fabric_id")
);
--> statement-breakpoint
ALTER TABLE "fabric_drift" ADD CONSTRAINT "fabric_drift_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fabric_drift" ADD CONSTRAINT "fabric_drift_fabric_id_project_fabrics_id_fk" FOREIGN KEY ("fabric_id") REFERENCES "public"."project_fabrics"("id") ON DELETE cascade ON UPDATE no action;