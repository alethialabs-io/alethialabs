ALTER TYPE "public"."cloud_identity_status" ADD VALUE 'degraded' BEFORE 'failed';--> statement-breakpoint
ALTER TYPE "public"."cloud_identity_status" ADD VALUE 'disconnected' BEFORE 'failed';--> statement-breakpoint
CREATE TABLE "cloud_caches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cloud_identity_id" uuid NOT NULL,
	"provider" "cloud_provider" NOT NULL,
	"region" text,
	"native_id" text NOT NULL,
	"name" text,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"engine" text,
	"engine_version" text,
	"memory_gb" numeric(8, 2),
	"endpoint" text,
	CONSTRAINT "cloud_caches_identity_native_key" UNIQUE("cloud_identity_id","provider","native_id")
);
--> statement-breakpoint
CREATE TABLE "cloud_container_registries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cloud_identity_id" uuid NOT NULL,
	"provider" "cloud_provider" NOT NULL,
	"region" text,
	"native_id" text NOT NULL,
	"name" text,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"repository_url" text,
	CONSTRAINT "cloud_container_registries_identity_native_key" UNIQUE("cloud_identity_id","provider","native_id")
);
--> statement-breakpoint
CREATE TABLE "cloud_databases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cloud_identity_id" uuid NOT NULL,
	"provider" "cloud_provider" NOT NULL,
	"region" text,
	"native_id" text NOT NULL,
	"name" text,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"engine_family" text,
	"engine" text,
	"engine_version" text,
	"endpoint" text,
	CONSTRAINT "cloud_databases_identity_native_key" UNIQUE("cloud_identity_id","provider","native_id")
);
--> statement-breakpoint
CREATE TABLE "cloud_dns_zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cloud_identity_id" uuid NOT NULL,
	"provider" "cloud_provider" NOT NULL,
	"region" text,
	"native_id" text NOT NULL,
	"name" text,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"domain" text,
	"is_private" boolean DEFAULT false,
	CONSTRAINT "cloud_dns_zones_identity_native_key" UNIQUE("cloud_identity_id","provider","native_id")
);
--> statement-breakpoint
CREATE TABLE "cloud_kubernetes_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cloud_identity_id" uuid NOT NULL,
	"provider" "cloud_provider" NOT NULL,
	"region" text,
	"native_id" text NOT NULL,
	"name" text,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"version" text,
	"endpoint" text,
	"network_id" uuid,
	CONSTRAINT "cloud_kubernetes_clusters_identity_native_key" UNIQUE("cloud_identity_id","provider","native_id")
);
--> statement-breakpoint
CREATE TABLE "cloud_networks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cloud_identity_id" uuid NOT NULL,
	"provider" "cloud_provider" NOT NULL,
	"region" text,
	"native_id" text NOT NULL,
	"name" text,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"cidr_block" text,
	"is_default" boolean DEFAULT false,
	CONSTRAINT "cloud_networks_identity_native_key" UNIQUE("cloud_identity_id","provider","native_id")
);
--> statement-breakpoint
CREATE TABLE "cloud_nics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cloud_identity_id" uuid NOT NULL,
	"provider" "cloud_provider" NOT NULL,
	"region" text,
	"native_id" text NOT NULL,
	"name" text,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"subnet_id" uuid,
	"private_ip" text,
	"public_ip" text,
	CONSTRAINT "cloud_nics_identity_native_key" UNIQUE("cloud_identity_id","provider","native_id")
);
--> statement-breakpoint
CREATE TABLE "cloud_nosql_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cloud_identity_id" uuid NOT NULL,
	"provider" "cloud_provider" NOT NULL,
	"region" text,
	"native_id" text NOT NULL,
	"name" text,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "cloud_nosql_tables_identity_native_key" UNIQUE("cloud_identity_id","provider","native_id")
);
--> statement-breakpoint
CREATE TABLE "cloud_queues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cloud_identity_id" uuid NOT NULL,
	"provider" "cloud_provider" NOT NULL,
	"region" text,
	"native_id" text NOT NULL,
	"name" text,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "cloud_queues_identity_native_key" UNIQUE("cloud_identity_id","provider","native_id")
);
--> statement-breakpoint
CREATE TABLE "cloud_regions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cloud_identity_id" uuid NOT NULL,
	"provider" "cloud_provider" NOT NULL,
	"region" text,
	"native_id" text NOT NULL,
	"name" text,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "cloud_regions_identity_native_key" UNIQUE("cloud_identity_id","provider","native_id")
);
--> statement-breakpoint
CREATE TABLE "cloud_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cloud_identity_id" uuid NOT NULL,
	"provider" "cloud_provider" NOT NULL,
	"region" text,
	"native_id" text NOT NULL,
	"name" text,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"kind" text NOT NULL,
	"parent_native_id" text,
	CONSTRAINT "cloud_resources_identity_native_key" UNIQUE("cloud_identity_id","provider","native_id")
);
--> statement-breakpoint
CREATE TABLE "cloud_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cloud_identity_id" uuid NOT NULL,
	"provider" "cloud_provider" NOT NULL,
	"region" text,
	"native_id" text NOT NULL,
	"name" text,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "cloud_secrets_identity_native_key" UNIQUE("cloud_identity_id","provider","native_id")
);
--> statement-breakpoint
CREATE TABLE "cloud_storage_buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cloud_identity_id" uuid NOT NULL,
	"provider" "cloud_provider" NOT NULL,
	"region" text,
	"native_id" text NOT NULL,
	"name" text,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "cloud_storage_buckets_identity_native_key" UNIQUE("cloud_identity_id","provider","native_id")
);
--> statement-breakpoint
CREATE TABLE "cloud_subnets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cloud_identity_id" uuid NOT NULL,
	"provider" "cloud_provider" NOT NULL,
	"region" text,
	"native_id" text NOT NULL,
	"name" text,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"network_id" uuid,
	"cidr_block" text,
	"availability_zone" text,
	"is_public" boolean DEFAULT false,
	CONSTRAINT "cloud_subnets_identity_native_key" UNIQUE("cloud_identity_id","provider","native_id")
);
--> statement-breakpoint
CREATE TABLE "cloud_topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cloud_identity_id" uuid NOT NULL,
	"provider" "cloud_provider" NOT NULL,
	"region" text,
	"native_id" text NOT NULL,
	"name" text,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "cloud_topics_identity_native_key" UNIQUE("cloud_identity_id","provider","native_id")
);
--> statement-breakpoint
ALTER TABLE "cloud_identities" ADD COLUMN "verified_account_id" text;--> statement-breakpoint
ALTER TABLE "cloud_identities" ADD COLUMN "missing_permissions" text[] DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "cloud_identities" ADD COLUMN "inventory_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cloud_caches" ADD CONSTRAINT "cloud_caches_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_container_registries" ADD CONSTRAINT "cloud_container_registries_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_databases" ADD CONSTRAINT "cloud_databases_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_dns_zones" ADD CONSTRAINT "cloud_dns_zones_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_kubernetes_clusters" ADD CONSTRAINT "cloud_kubernetes_clusters_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_kubernetes_clusters" ADD CONSTRAINT "cloud_kubernetes_clusters_network_id_cloud_networks_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."cloud_networks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_networks" ADD CONSTRAINT "cloud_networks_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_nics" ADD CONSTRAINT "cloud_nics_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_nics" ADD CONSTRAINT "cloud_nics_subnet_id_cloud_subnets_id_fk" FOREIGN KEY ("subnet_id") REFERENCES "public"."cloud_subnets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_nosql_tables" ADD CONSTRAINT "cloud_nosql_tables_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_queues" ADD CONSTRAINT "cloud_queues_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_regions" ADD CONSTRAINT "cloud_regions_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_resources" ADD CONSTRAINT "cloud_resources_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_secrets" ADD CONSTRAINT "cloud_secrets_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_storage_buckets" ADD CONSTRAINT "cloud_storage_buckets_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_subnets" ADD CONSTRAINT "cloud_subnets_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_subnets" ADD CONSTRAINT "cloud_subnets_network_id_cloud_networks_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."cloud_networks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_topics" ADD CONSTRAINT "cloud_topics_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cloud_caches_identity" ON "cloud_caches" USING btree ("cloud_identity_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_container_registries_identity" ON "cloud_container_registries" USING btree ("cloud_identity_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_databases_identity" ON "cloud_databases" USING btree ("cloud_identity_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_dns_zones_identity" ON "cloud_dns_zones" USING btree ("cloud_identity_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_kubernetes_clusters_identity" ON "cloud_kubernetes_clusters" USING btree ("cloud_identity_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_networks_identity" ON "cloud_networks" USING btree ("cloud_identity_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_nics_identity" ON "cloud_nics" USING btree ("cloud_identity_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_nosql_tables_identity" ON "cloud_nosql_tables" USING btree ("cloud_identity_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_queues_identity" ON "cloud_queues" USING btree ("cloud_identity_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_regions_identity" ON "cloud_regions" USING btree ("cloud_identity_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_resources_identity" ON "cloud_resources" USING btree ("cloud_identity_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_resources_kind" ON "cloud_resources" USING btree ("cloud_identity_id","kind");--> statement-breakpoint
CREATE INDEX "idx_cloud_secrets_identity" ON "cloud_secrets" USING btree ("cloud_identity_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_storage_buckets_identity" ON "cloud_storage_buckets" USING btree ("cloud_identity_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_subnets_identity" ON "cloud_subnets" USING btree ("cloud_identity_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_subnets_network" ON "cloud_subnets" USING btree ("network_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_topics_identity" ON "cloud_topics" USING btree ("cloud_identity_id");