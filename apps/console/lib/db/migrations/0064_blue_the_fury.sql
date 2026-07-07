CREATE TABLE "environment_security" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid,
	"critical" integer DEFAULT 0 NOT NULL,
	"high" integer DEFAULT 0 NOT NULL,
	"medium" integer DEFAULT 0 NOT NULL,
	"low" integer DEFAULT 0 NOT NULL,
	"report_count" integer DEFAULT 0 NOT NULL,
	"scanned" boolean DEFAULT false NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_security_project_id_environment_id_key" UNIQUE("project_id","environment_id")
);
--> statement-breakpoint
ALTER TABLE "environment_security" ADD CONSTRAINT "environment_security_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_security" ADD CONSTRAINT "environment_security_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;