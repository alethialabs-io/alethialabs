-- Cloud-inventory data-custody hardening: drop the wholesale-tag `attributes` JSONB and the plaintext
-- reconnaissance-sensitive columns (CIDRs/IPs/endpoints/domains) from every inventory table, and add a
-- single `sensitive` text column that holds an AES-GCM envelope of those attributes (encrypt on write,
-- decrypt on read). Identifiers (native_id/name/region + typed low-sensitivity columns) stay plaintext.
-- Inventory is a re-derivable projection (the cloud is source of truth), so existing rows just re-sync.
ALTER TABLE "cloud_regions" DROP COLUMN IF EXISTS "attributes", ADD COLUMN IF NOT EXISTS "sensitive" text;--> statement-breakpoint
ALTER TABLE "cloud_networks" DROP COLUMN IF EXISTS "attributes", DROP COLUMN IF EXISTS "cidr_block", ADD COLUMN IF NOT EXISTS "sensitive" text;--> statement-breakpoint
ALTER TABLE "cloud_subnets" DROP COLUMN IF EXISTS "attributes", DROP COLUMN IF EXISTS "cidr_block", ADD COLUMN IF NOT EXISTS "sensitive" text;--> statement-breakpoint
ALTER TABLE "cloud_nics" DROP COLUMN IF EXISTS "attributes", DROP COLUMN IF EXISTS "private_ip", DROP COLUMN IF EXISTS "public_ip", ADD COLUMN IF NOT EXISTS "sensitive" text;--> statement-breakpoint
ALTER TABLE "cloud_dns_zones" DROP COLUMN IF EXISTS "attributes", DROP COLUMN IF EXISTS "domain", ADD COLUMN IF NOT EXISTS "sensitive" text;--> statement-breakpoint
ALTER TABLE "cloud_kubernetes_clusters" DROP COLUMN IF EXISTS "attributes", DROP COLUMN IF EXISTS "endpoint", ADD COLUMN IF NOT EXISTS "sensitive" text;--> statement-breakpoint
ALTER TABLE "cloud_databases" DROP COLUMN IF EXISTS "attributes", DROP COLUMN IF EXISTS "endpoint", ADD COLUMN IF NOT EXISTS "sensitive" text;--> statement-breakpoint
ALTER TABLE "cloud_caches" DROP COLUMN IF EXISTS "attributes", DROP COLUMN IF EXISTS "endpoint", ADD COLUMN IF NOT EXISTS "sensitive" text;--> statement-breakpoint
ALTER TABLE "cloud_queues" DROP COLUMN IF EXISTS "attributes", ADD COLUMN IF NOT EXISTS "sensitive" text;--> statement-breakpoint
ALTER TABLE "cloud_topics" DROP COLUMN IF EXISTS "attributes", ADD COLUMN IF NOT EXISTS "sensitive" text;--> statement-breakpoint
ALTER TABLE "cloud_nosql_tables" DROP COLUMN IF EXISTS "attributes", ADD COLUMN IF NOT EXISTS "sensitive" text;--> statement-breakpoint
ALTER TABLE "cloud_container_registries" DROP COLUMN IF EXISTS "attributes", DROP COLUMN IF EXISTS "repository_url", ADD COLUMN IF NOT EXISTS "sensitive" text;--> statement-breakpoint
ALTER TABLE "cloud_secrets" DROP COLUMN IF EXISTS "attributes", ADD COLUMN IF NOT EXISTS "sensitive" text;--> statement-breakpoint
ALTER TABLE "cloud_storage_buckets" DROP COLUMN IF EXISTS "attributes", ADD COLUMN IF NOT EXISTS "sensitive" text;--> statement-breakpoint
ALTER TABLE "cloud_resources" DROP COLUMN IF EXISTS "attributes", ADD COLUMN IF NOT EXISTS "sensitive" text;
