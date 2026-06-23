CREATE TABLE "spec_environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"spec_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"name" text NOT NULL,
	"stage" "environment_stage" DEFAULT 'development' NOT NULL,
	"status" "spec_status" DEFAULT 'DRAFT' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"region" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spec_environments_spec_id_name_key" UNIQUE("spec_id","name")
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "spec_environments" ADD CONSTRAINT "spec_environments_spec_id_specs_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "spec_environments_one_default" ON "spec_environments" USING btree ("spec_id") WHERE "spec_environments"."is_default" = true;--> statement-breakpoint
CREATE INDEX "idx_spec_environments_spec" ON "spec_environments" USING btree ("spec_id");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_environment_id_spec_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."spec_environments"("id") ON DELETE set null ON UPDATE no action;