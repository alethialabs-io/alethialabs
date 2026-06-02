-- Remove legacy repo fields — terraform and gitops repos are now platform-managed.
-- Only apps_destination_repo remains for optional user app GitOps.

-- The vine_full view references these columns, so drop it first.
DROP VIEW IF EXISTS public.vine_full;

ALTER TABLE vine_repositories
  DROP COLUMN IF EXISTS env_destination_repo,
  DROP COLUMN IF EXISTS env_template_repo,
  DROP COLUMN IF EXISTS env_template_branch,
  DROP COLUMN IF EXISTS gitops_destination_repo,
  DROP COLUMN IF EXISTS gitops_template_repo,
  DROP COLUMN IF EXISTS gitops_template_branch,
  DROP COLUMN IF EXISTS apps_template_repo,
  DROP COLUMN IF EXISTS apps_template_branch;

-- Recreate the view without the dropped columns.
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
