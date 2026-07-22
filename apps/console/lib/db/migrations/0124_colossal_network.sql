CREATE TYPE "public"."capability_service_kind" AS ENUM('database', 'cache', 'kubernetes', 'nosql');--> statement-breakpoint
CREATE TABLE "cloud_capability_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cloud_identity_id" uuid NOT NULL,
	"provider" "cloud_provider" NOT NULL,
	"region" text,
	"native_id" text NOT NULL,
	"name" text,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"service_kind" "capability_service_kind" NOT NULL,
	"engine" text,
	"version" text,
	"tier" text,
	"mem_gb" numeric(8, 2),
	"launchable" "capability_launchable" DEFAULT 'not_evaluable' NOT NULL,
	"launchable_reason" "capability_launchable_reason",
	CONSTRAINT "cloud_capability_services_identity_region_kind_native_key" UNIQUE("cloud_identity_id","provider","region","service_kind","native_id")
);
--> statement-breakpoint
ALTER TABLE "cloud_capability_services" ADD CONSTRAINT "cloud_capability_services_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cloud_capability_services_identity" ON "cloud_capability_services" USING btree ("cloud_identity_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_capability_services_identity_kind" ON "cloud_capability_services" USING btree ("cloud_identity_id","service_kind");