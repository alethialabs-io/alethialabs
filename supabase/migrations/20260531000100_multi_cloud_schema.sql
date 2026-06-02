-- Multi-Cloud Schema: Rename AWS-specific tables/columns to cloud-agnostic equivalents
-- All ALTER TABLE RENAME operations are metadata-only (zero downtime, preserves data/FKs/indexes)

-- ============================================================
-- Phase A: Rename tables
-- ============================================================
ALTER TABLE public.vine_eks RENAME TO vine_cluster;
ALTER TABLE public.vine_vpc RENAME TO vine_network;
ALTER TABLE public.vine_dynamodb_tables RENAME TO vine_nosql_tables;
ALTER TABLE public.vine_ecr_repos RENAME TO vine_container_registries;
ALTER TABLE public.eks_admins RENAME TO cluster_admins;

-- ============================================================
-- Phase B: Rename columns
-- ============================================================

-- Drop the view first since it depends on columns we're renaming/dropping
DROP VIEW IF EXISTS public.vine_full;

-- vines: aws_region -> region, drop aws_account_id
ALTER TABLE public.vines RENAME COLUMN aws_region TO region;
ALTER TABLE public.vines DROP COLUMN IF EXISTS aws_account_id;

-- vine_network (was vine_vpc)
ALTER TABLE public.vine_network RENAME COLUMN provision_vpc TO provision_network;
ALTER TABLE public.vine_network RENAME COLUMN vpc_id TO network_id;
ALTER TABLE public.vine_network RENAME COLUMN vpc_cidr TO cidr_block;

-- vine_dns
ALTER TABLE public.vine_dns RENAME COLUMN hosted_zone_id TO zone_id;

-- ============================================================
-- Phase C: Add new columns
-- ============================================================

-- provider_config JSONB on tables that need provider-specific overrides
ALTER TABLE public.vine_cluster ADD COLUMN IF NOT EXISTS provider_config JSONB DEFAULT '{}'::jsonb;
ALTER TABLE public.vine_dns ADD COLUMN IF NOT EXISTS provider_config JSONB DEFAULT '{}'::jsonb;
ALTER TABLE public.vine_nosql_tables ADD COLUMN IF NOT EXISTS provider_config JSONB DEFAULT '{}'::jsonb;
ALTER TABLE public.vine_container_registries ADD COLUMN IF NOT EXISTS provider_config JSONB DEFAULT '{}'::jsonb;

-- vine_dns: generic flags replacing AWS-specific columns
ALTER TABLE public.vine_dns ADD COLUMN IF NOT EXISTS managed_certificate BOOLEAN DEFAULT false;
ALTER TABLE public.vine_dns ADD COLUMN IF NOT EXISTS waf_enabled BOOLEAN DEFAULT false;

-- ============================================================
-- Phase D: Backfill provider_config from existing columns
-- ============================================================

-- vine_cluster: move enable_karpenter into provider_config
UPDATE public.vine_cluster
SET provider_config = jsonb_build_object('enable_karpenter', COALESCE(enable_karpenter, true))
WHERE provider_config = '{}'::jsonb;

-- vine_dns: backfill generic flags + move AWS-specific into provider_config
UPDATE public.vine_dns
SET
  managed_certificate = COALESCE(acm_certificate, false),
  waf_enabled = COALESCE(cloudfront_waf, false) OR COALESCE(application_waf, false),
  provider_config = jsonb_build_object(
    'acm_certificate', COALESCE(acm_certificate, false),
    'cloudfront_waf', COALESCE(cloudfront_waf, false),
    'application_waf', COALESCE(application_waf, false)
  )
WHERE provider_config = '{}'::jsonb;

-- ============================================================
-- Phase E: Drop old columns
-- ============================================================
ALTER TABLE public.vine_cluster DROP COLUMN IF EXISTS enable_karpenter;
ALTER TABLE public.vine_dns DROP COLUMN IF EXISTS acm_certificate;
ALTER TABLE public.vine_dns DROP COLUMN IF EXISTS cloudfront_waf;
ALTER TABLE public.vine_dns DROP COLUMN IF EXISTS application_waf;

-- ============================================================
-- Phase F: Rename constraints
-- ============================================================
ALTER INDEX IF EXISTS vine_dynamodb_name_unique RENAME TO vine_nosql_name_unique;
ALTER INDEX IF EXISTS vine_ecr_name_unique RENAME TO vine_registry_name_unique;

-- ============================================================
-- Phase G: Rename enums (create new, alter column, drop old)
-- ============================================================

-- dynamodb_table_type -> nosql_table_type
CREATE TYPE public.nosql_table_type AS ENUM ('standard', 'global');
ALTER TABLE public.vine_nosql_tables
  ALTER COLUMN table_type DROP DEFAULT,
  ALTER COLUMN table_type TYPE public.nosql_table_type USING table_type::text::public.nosql_table_type,
  ALTER COLUMN table_type SET DEFAULT 'standard';
DROP TYPE IF EXISTS public.dynamodb_table_type;

-- dynamodb_key_type -> nosql_key_type
CREATE TYPE public.nosql_key_type AS ENUM ('S', 'N', 'B');
ALTER TABLE public.vine_nosql_tables
  ALTER COLUMN hash_key_type DROP DEFAULT,
  ALTER COLUMN hash_key_type TYPE public.nosql_key_type USING hash_key_type::text::public.nosql_key_type,
  ALTER COLUMN hash_key_type SET DEFAULT 'S';
ALTER TABLE public.vine_nosql_tables
  ALTER COLUMN range_key_type TYPE public.nosql_key_type USING range_key_type::text::public.nosql_key_type;
DROP TYPE IF EXISTS public.dynamodb_key_type;

-- dynamodb_billing_mode -> nosql_billing_mode
CREATE TYPE public.nosql_billing_mode AS ENUM ('PAY_PER_REQUEST', 'PROVISIONED');
ALTER TABLE public.vine_nosql_tables
  ALTER COLUMN billing_mode DROP DEFAULT,
  ALTER COLUMN billing_mode TYPE public.nosql_billing_mode USING billing_mode::text::public.nosql_billing_mode,
  ALTER COLUMN billing_mode SET DEFAULT 'PAY_PER_REQUEST';
DROP TYPE IF EXISTS public.dynamodb_billing_mode;

-- ecr_tag_mutability -> registry_tag_mutability
CREATE TYPE public.registry_tag_mutability AS ENUM ('MUTABLE', 'IMMUTABLE');
ALTER TABLE public.vine_container_registries
  ALTER COLUMN image_tag_mutability DROP DEFAULT,
  ALTER COLUMN image_tag_mutability TYPE public.registry_tag_mutability USING image_tag_mutability::text::public.registry_tag_mutability,
  ALTER COLUMN image_tag_mutability SET DEFAULT 'MUTABLE';
DROP TYPE IF EXISTS public.ecr_tag_mutability;

-- ============================================================
-- Phase H: Recreate RLS policies with new table names
-- ============================================================

-- Drop old policies (they were auto-renamed with the tables but have stale names)
DROP POLICY IF EXISTS "Users manage own vine_vpc" ON public.vine_network;
DROP POLICY IF EXISTS "Users manage own vine_eks" ON public.vine_cluster;
DROP POLICY IF EXISTS "Users manage own vine_dynamodb_tables" ON public.vine_nosql_tables;
DROP POLICY IF EXISTS "Users manage own vine_ecr_repos" ON public.vine_container_registries;

-- Recreate with new names
CREATE POLICY "Users manage own vine_network" ON public.vine_network
  FOR ALL
  USING (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()))
  WITH CHECK (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()));

CREATE POLICY "Users manage own vine_cluster" ON public.vine_cluster
  FOR ALL
  USING (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()))
  WITH CHECK (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()));

CREATE POLICY "Users manage own vine_nosql_tables" ON public.vine_nosql_tables
  FOR ALL
  USING (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()))
  WITH CHECK (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()));

CREATE POLICY "Users manage own vine_container_registries" ON public.vine_container_registries
  FOR ALL
  USING (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()))
  WITH CHECK (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()));

-- ============================================================
-- Phase I: Recreate triggers (old triggers follow the table rename automatically,
-- but their names are stale — drop and recreate for clarity)
-- ============================================================
DROP TRIGGER IF EXISTS vine_vpc_updated_at ON public.vine_network;
DROP TRIGGER IF EXISTS vine_eks_updated_at ON public.vine_cluster;
DROP TRIGGER IF EXISTS vine_dynamodb_tables_updated_at ON public.vine_nosql_tables;
DROP TRIGGER IF EXISTS vine_ecr_repos_updated_at ON public.vine_container_registries;

CREATE TRIGGER vine_network_updated_at BEFORE UPDATE ON public.vine_network
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER vine_cluster_updated_at BEFORE UPDATE ON public.vine_cluster
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER vine_nosql_tables_updated_at BEFORE UPDATE ON public.vine_nosql_tables
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER vine_container_registries_updated_at BEFORE UPDATE ON public.vine_container_registries
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- Phase J: Recreate backward-compatibility view
-- ============================================================
DROP VIEW IF EXISTS public.vine_full;
CREATE OR REPLACE VIEW public.vine_full AS
SELECT
  v.id, v.user_id, v.vineyard_id, v.cloud_identity_id,
  v.project_name,
  v.environment_stage::text AS environment_stage,
  v.region,
  v.region AS aws_region,
  ci.provider AS cloud_provider,
  ci.credentials->>'account_id' AS aws_account_id,
  v.terraform_version,
  v.status::text AS status,
  v.estimated_monthly_cost,
  v.created_at, v.updated_at,

  -- Network
  net.provision_network AS create_vpc,
  net.cidr_block AS vpc_cidr,
  net.network_id AS selected_vpc_id,
  net.single_nat_gateway,
  net.status::text AS network_status,
  net.status::text AS vpc_status,

  -- Cluster
  cl.cluster_version,
  (cl.provider_config->>'enable_karpenter')::boolean AS enable_karpenter,
  cl.cluster_admins,
  cl.instance_types,
  cl.node_min_size, cl.node_max_size, cl.node_desired_size,
  cl.cluster_name, cl.cluster_endpoint,
  cl.status::text AS cluster_status,
  cl.status::text AS eks_status,

  -- DNS
  dns.enabled AS enable_dns,
  dns.domain_name AS dns_main_domain,
  dns.zone_id AS dns_hosted_zone,
  dns.managed_certificate AS acm_certificate_enable,
  dns.waf_enabled,
  (dns.provider_config->>'cloudfront_waf')::boolean AS cloudfront_waf_enabled,
  (dns.provider_config->>'application_waf')::boolean AS application_waf_enabled,
  dns.status::text AS dns_status,

  -- Repositories
  repos.env_template_repo,
  repos.env_template_branch AS env_template_repo_branch,
  repos.env_destination_repo AS env_git_repo,
  repos.gitops_template_repo,
  repos.gitops_template_branch AS gitops_template_repo_branch,
  repos.gitops_destination_repo,
  repos.apps_template_repo AS applications_template_repo,
  repos.apps_template_branch AS applications_template_repo_branch,
  repos.apps_destination_repo AS applications_destination_repo,

  -- Aggregated
  EXISTS(SELECT 1 FROM public.vine_databases d WHERE d.vine_id = v.id AND d.status != 'DESTROYED') AS create_rds,
  (SELECT MIN(d.min_capacity) FROM public.vine_databases d WHERE d.vine_id = v.id AND d.status != 'DESTROYED') AS db_min_capacity,
  (SELECT MAX(d.max_capacity) FROM public.vine_databases d WHERE d.vine_id = v.id AND d.status != 'DESTROYED') AS db_max_capacity,
  EXISTS(SELECT 1 FROM public.vine_caches c WHERE c.vine_id = v.id AND c.status != 'DESTROYED') AS enable_redis

FROM public.vines v
LEFT JOIN public.cloud_identities ci ON ci.id = v.cloud_identity_id
LEFT JOIN public.vine_network net ON net.vine_id = v.id
LEFT JOIN public.vine_cluster cl ON cl.vine_id = v.id
LEFT JOIN public.vine_dns dns ON dns.vine_id = v.id
LEFT JOIN public.vine_repositories repos ON repos.vine_id = v.id;

-- ============================================================
-- Phase K: Update realtime publication
-- Renamed tables keep their publication membership automatically,
-- so no changes needed here. The publication already tracks the
-- new table names (vine_network, vine_cluster, etc.) since
-- ALTER TABLE RENAME updates pg_publication_rel in place.
-- ============================================================
