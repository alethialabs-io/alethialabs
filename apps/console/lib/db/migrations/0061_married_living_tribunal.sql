CREATE TYPE "public"."resource_kind" AS ENUM('cloud_identity', 'connector_credential', 'alert_rule', 'alert_channel', 'alert_delivery', 'member', 'project', 'project_environment', 'project_cluster', 'cloud_kubernetes_cluster', 'role', 'runner', 'runner_usage_session', 'support_case');--> statement-breakpoint
CREATE TABLE "classification_dimension" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"multi" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classification_dimension_org_key" UNIQUE("org_id","key")
);
--> statement-breakpoint
CREATE TABLE "classification_value" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"dimension_id" uuid NOT NULL,
	"value" text NOT NULL,
	"label" text NOT NULL,
	"color" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classification_value_dimension_value" UNIQUE("dimension_id","value")
);
--> statement-breakpoint
CREATE TABLE "classification_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"dimension_id" uuid NOT NULL,
	"value_id" uuid NOT NULL,
	"resource_kind" "resource_kind" NOT NULL,
	"resource_id" uuid NOT NULL,
	"assigned_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classification_assignment_resource_value" UNIQUE("resource_kind","resource_id","value_id")
);
--> statement-breakpoint
ALTER TABLE "classification_value" ADD CONSTRAINT "classification_value_dimension_id_classification_dimension_id_fk" FOREIGN KEY ("dimension_id") REFERENCES "public"."classification_dimension"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classification_assignment" ADD CONSTRAINT "classification_assignment_dimension_id_classification_dimension_id_fk" FOREIGN KEY ("dimension_id") REFERENCES "public"."classification_dimension"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classification_assignment" ADD CONSTRAINT "classification_assignment_value_id_classification_value_id_fk" FOREIGN KEY ("value_id") REFERENCES "public"."classification_value"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_classification_dimension_org" ON "classification_dimension" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_classification_value_dimension" ON "classification_value" USING btree ("dimension_id");--> statement-breakpoint
CREATE INDEX "idx_classification_value_org" ON "classification_value" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_classification_assignment_resource" ON "classification_assignment" USING btree ("resource_kind","resource_id");--> statement-breakpoint
CREATE INDEX "idx_classification_assignment_value" ON "classification_assignment" USING btree ("value_id");--> statement-breakpoint
CREATE INDEX "idx_classification_assignment_dimension" ON "classification_assignment" USING btree ("dimension_id");--> statement-breakpoint
CREATE INDEX "idx_classification_assignment_org" ON "classification_assignment" USING btree ("org_id");
