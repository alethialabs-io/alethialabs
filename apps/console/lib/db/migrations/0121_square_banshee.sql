CREATE TYPE "public"."capability_launchable" AS ENUM('launchable', 'not_launchable', 'not_evaluable');--> statement-breakpoint
CREATE TYPE "public"."capability_launchable_reason" AS ENUM('available', 'region_not_offered', 'quota_zero', 'sku_restricted', 'not_available_for_subscription', 'sold_out', 'capacity_blocked', 'quota_unknown');--> statement-breakpoint
CREATE TABLE "cloud_capability_instance_types" (
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
	"vcpu" integer,
	"mem_gb" numeric(8, 2),
	"family" text,
	"arch" text,
	"launchable" "capability_launchable" DEFAULT 'not_evaluable' NOT NULL,
	"launchable_reason" "capability_launchable_reason",
	CONSTRAINT "cloud_capability_instance_types_identity_region_native_key" UNIQUE("cloud_identity_id","provider","region","native_id")
);
--> statement-breakpoint
CREATE TABLE "cloud_capability_regions" (
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
	CONSTRAINT "cloud_capability_regions_identity_native_key" UNIQUE("cloud_identity_id","provider","native_id")
);
--> statement-breakpoint
ALTER TABLE "cloud_identities" ADD COLUMN "capabilities_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cloud_capability_instance_types" ADD CONSTRAINT "cloud_capability_instance_types_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_capability_regions" ADD CONSTRAINT "cloud_capability_regions_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cloud_capability_instance_types_identity" ON "cloud_capability_instance_types" USING btree ("cloud_identity_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_capability_regions_identity" ON "cloud_capability_regions" USING btree ("cloud_identity_id");