CREATE TYPE "public"."capability_quota_kind" AS ENUM('elastic_ip', 'nat_gateway', 'load_balancer', 'security_group');--> statement-breakpoint
CREATE TABLE "cloud_capability_quotas" (
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
	"quota_kind" "capability_quota_kind" NOT NULL,
	"quota_limit" integer,
	"used" integer,
	"available" integer,
	CONSTRAINT "cloud_capability_quotas_identity_region_kind_native_key" UNIQUE("cloud_identity_id","provider","region","quota_kind","native_id")
);
--> statement-breakpoint
ALTER TABLE "cloud_capability_quotas" ADD CONSTRAINT "cloud_capability_quotas_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cloud_capability_quotas_identity" ON "cloud_capability_quotas" USING btree ("cloud_identity_id");