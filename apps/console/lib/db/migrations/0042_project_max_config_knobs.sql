-- Maximum-configuration parity knobs (B3): expose worker-node disk size, DB instance
-- class/tier, and cache engine version end-to-end. All nullable — NULL lets the per-cloud
-- template default apply (so existing projects are unchanged). The provider mappers map
-- node_disk_size_gb → eks_disk_size/gke_disk_size_gb/aks_disk_size_gb, instance_class →
-- rds_instance_type/cloud_sql_tier/azure_db_sku_name, engine_version →
-- redis_engine_version/memorystore_redis_version/azure_cache_redis_version.
-- Custom migration (db:generate blocked by unrelated pending enum drift in the working
-- tree — same pattern as 0041). Idempotent so a later drizzle-generated migration is safe.
ALTER TABLE "project_cluster" ADD COLUMN IF NOT EXISTS "node_disk_size_gb" integer;
ALTER TABLE "project_databases" ADD COLUMN IF NOT EXISTS "instance_class" text;
ALTER TABLE "project_caches" ADD COLUMN IF NOT EXISTS "engine_version" text;
