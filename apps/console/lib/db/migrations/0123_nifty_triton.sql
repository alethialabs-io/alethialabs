CREATE TYPE "public"."capability_sync_axis" AS ENUM('instance_types', 'quota');--> statement-breakpoint
CREATE TABLE "cloud_capability_sync_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cloud_identity_id" uuid NOT NULL,
	"provider" "cloud_provider" NOT NULL,
	"axis" "capability_sync_axis" NOT NULL,
	"region" text NOT NULL,
	"source_hash" text NOT NULL,
	"hashed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_capability_sync_state_identity_axis_region_key" UNIQUE("cloud_identity_id","provider","axis","region")
);
--> statement-breakpoint
ALTER TABLE "cloud_capability_sync_state" ADD CONSTRAINT "cloud_capability_sync_state_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cloud_capability_sync_state_identity" ON "cloud_capability_sync_state" USING btree ("cloud_identity_id");