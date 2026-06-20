CREATE TABLE "connector_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"connector_id" uuid NOT NULL,
	"credentials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_verified" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_credentials_user_connector_key" UNIQUE("user_id","connector_id")
);
--> statement-breakpoint
CREATE TABLE "spec_observability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"spec_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"provider" text,
	"provider_config" jsonb DEFAULT '{}'::jsonb,
	"status" "component_status" DEFAULT 'PENDING' NOT NULL,
	"status_message" text,
	"estimated_monthly_cost" numeric(12, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spec_observability_spec_id_unique" UNIQUE("spec_id")
);
--> statement-breakpoint
ALTER TABLE "spec_container_registries" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "spec_dns" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "spec_secrets" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "spec_secrets" ADD COLUMN "provider_config" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "connector_credentials" ADD CONSTRAINT "connector_credentials_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_observability" ADD CONSTRAINT "spec_observability_spec_id_specs_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_connector_credentials_user" ON "connector_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_connector_credentials_org" ON "connector_credentials" USING btree ("org_id");