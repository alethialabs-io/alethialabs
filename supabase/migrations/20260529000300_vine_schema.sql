-- Vine Schema: Normalize configurations into modular component tables
-- See spec/features/vine-schema-redesign/ for full design docs

-- ============================================================
-- ENUMS
-- ============================================================
CREATE TYPE public.vine_status AS ENUM (
  'DRAFT', 'QUEUED', 'PROVISIONING', 'ACTIVE', 'FAILED', 'DESTROYING', 'DESTROYED'
);

CREATE TYPE public.component_status AS ENUM (
  'PENDING', 'CREATING', 'ACTIVE', 'UPDATING', 'FAILED', 'DESTROYING', 'DESTROYED'
);

CREATE TYPE public.environment_stage AS ENUM (
  'development', 'staging', 'production'
);

CREATE TYPE public.cache_engine AS ENUM ('redis', 'valkey');

CREATE TYPE public.dynamodb_table_type AS ENUM ('standard', 'global');

CREATE TYPE public.dynamodb_key_type AS ENUM ('S', 'N', 'B');

CREATE TYPE public.dynamodb_billing_mode AS ENUM ('PAY_PER_REQUEST', 'PROVISIONED');

CREATE TYPE public.ecr_tag_mutability AS ENUM ('MUTABLE', 'IMMUTABLE');

CREATE TYPE public.git_credential_purpose AS ENUM ('argocd', 'applications', 'infrastructure');

CREATE TYPE public.git_credential_method AS ENUM ('oauth', 'pat', 'deploy_key');

CREATE TYPE public.audit_action AS ENUM (
  'CREATED', 'UPDATED', 'DELETED', 'PROVISIONED', 'DESTROYED',
  'COMPONENT_ADDED', 'COMPONENT_UPDATED', 'COMPONENT_REMOVED', 'STATUS_CHANGED'
);

-- ============================================================
-- Helper: auto-update updated_at on row change
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 1. VINES — the orchestrator (replaces configurations)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.vines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL DEFAULT auth.uid(),
  vineyard_id UUID REFERENCES public.vineyards(id) ON DELETE SET NULL,
  cloud_identity_id UUID REFERENCES public.cloud_identities(id) ON DELETE SET NULL,

  project_name TEXT NOT NULL,
  environment_stage public.environment_stage NOT NULL DEFAULT 'development',
  aws_region TEXT NOT NULL DEFAULT 'eu-west-1',
  aws_account_id TEXT,
  terraform_version TEXT NOT NULL DEFAULT '1.11.4',

  status public.vine_status NOT NULL DEFAULT 'DRAFT',

  estimated_monthly_cost FLOAT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.vines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own vines" ON public.vines
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER vines_updated_at BEFORE UPDATE ON public.vines
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 2. SINGLETON COMPONENTS (1:1 per vine)
-- ============================================================

-- VPC & Networking
CREATE TABLE IF NOT EXISTS public.vine_vpc (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vine_id UUID NOT NULL UNIQUE REFERENCES public.vines(id) ON DELETE CASCADE,

  provision_vpc BOOLEAN NOT NULL DEFAULT true,
  vpc_id TEXT,
  vpc_cidr TEXT DEFAULT '10.0.0.0/16',
  single_nat_gateway BOOLEAN DEFAULT true,
  allowed_cidr_blocks TEXT[] DEFAULT '{}',

  status public.component_status NOT NULL DEFAULT 'PENDING',
  status_message TEXT,
  estimated_monthly_cost FLOAT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- EKS Cluster
CREATE TABLE IF NOT EXISTS public.vine_eks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vine_id UUID NOT NULL UNIQUE REFERENCES public.vines(id) ON DELETE CASCADE,

  cluster_version TEXT DEFAULT '1.32',
  enable_karpenter BOOLEAN DEFAULT true,
  cluster_admins JSONB DEFAULT '[]'::jsonb,
  instance_types TEXT[] DEFAULT '{t3.medium}',
  node_min_size INT DEFAULT 2,
  node_max_size INT DEFAULT 5,
  node_desired_size INT DEFAULT 2,

  status public.component_status NOT NULL DEFAULT 'PENDING',
  status_message TEXT,
  estimated_monthly_cost FLOAT,
  cluster_name TEXT,
  cluster_endpoint TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- DNS & Certificates
CREATE TABLE IF NOT EXISTS public.vine_dns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vine_id UUID NOT NULL UNIQUE REFERENCES public.vines(id) ON DELETE CASCADE,

  enabled BOOLEAN NOT NULL DEFAULT false,
  hosted_zone_id TEXT,
  domain_name TEXT,
  acm_certificate BOOLEAN DEFAULT false,
  cloudfront_waf BOOLEAN DEFAULT false,
  application_waf BOOLEAN DEFAULT false,

  status public.component_status NOT NULL DEFAULT 'PENDING',
  status_message TEXT,
  estimated_monthly_cost FLOAT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Git Repositories (templates + destinations, NO tokens here)
CREATE TABLE IF NOT EXISTS public.vine_repositories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vine_id UUID NOT NULL UNIQUE REFERENCES public.vines(id) ON DELETE CASCADE,

  env_template_repo TEXT NOT NULL DEFAULT 'git@github.com:itgix/adp-tf-envtempl-standard.git',
  env_template_branch TEXT DEFAULT 'v1.2.7',
  env_destination_repo TEXT,

  gitops_template_repo TEXT NOT NULL DEFAULT 'git@github.com:itgix/adp-k8s-templ-argoinfrasvcs.git',
  gitops_template_branch TEXT DEFAULT 'v1.2.11',
  gitops_destination_repo TEXT,

  apps_template_repo TEXT,
  apps_template_branch TEXT,
  apps_destination_repo TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 3. MULTI-INSTANCE COMPONENTS (1:N per vine)
-- ============================================================

-- RDS Aurora databases
CREATE TABLE IF NOT EXISTS public.vine_databases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vine_id UUID NOT NULL REFERENCES public.vines(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  engine TEXT DEFAULT 'aurora-postgresql',
  engine_version TEXT DEFAULT '14.5',
  min_capacity FLOAT DEFAULT 0.5,
  max_capacity FLOAT DEFAULT 4,
  port INT DEFAULT 5432,
  backup_retention_days INT DEFAULT 7,
  iam_auth BOOLEAN DEFAULT false,

  status public.component_status NOT NULL DEFAULT 'PENDING',
  status_message TEXT,
  estimated_monthly_cost FLOAT,
  endpoint TEXT,
  reader_endpoint TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT vine_databases_name_unique UNIQUE (vine_id, name)
);

-- ElastiCache Redis/Valkey
CREATE TABLE IF NOT EXISTS public.vine_caches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vine_id UUID NOT NULL REFERENCES public.vines(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  engine public.cache_engine DEFAULT 'redis',
  node_type TEXT DEFAULT 'cache.t3.medium',
  num_cache_nodes INT DEFAULT 1,
  multi_az BOOLEAN DEFAULT false,
  allowed_cidr_blocks TEXT[] DEFAULT '{}',

  status public.component_status NOT NULL DEFAULT 'PENDING',
  status_message TEXT,
  estimated_monthly_cost FLOAT,
  endpoint TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT vine_caches_name_unique UNIQUE (vine_id, name)
);

-- SQS Queues
CREATE TABLE IF NOT EXISTS public.vine_queues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vine_id UUID NOT NULL REFERENCES public.vines(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  fifo BOOLEAN DEFAULT false,
  visibility_timeout INT DEFAULT 30,
  message_retention INT DEFAULT 345600,
  delay_seconds INT DEFAULT 0,

  status public.component_status NOT NULL DEFAULT 'PENDING',
  status_message TEXT,
  estimated_monthly_cost FLOAT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT vine_queues_name_unique UNIQUE (vine_id, name)
);

-- SNS Topics
CREATE TABLE IF NOT EXISTS public.vine_topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vine_id UUID NOT NULL REFERENCES public.vines(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  subscriptions JSONB DEFAULT '[]'::jsonb,

  status public.component_status NOT NULL DEFAULT 'PENDING',
  status_message TEXT,
  estimated_monthly_cost FLOAT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT vine_topics_name_unique UNIQUE (vine_id, name)
);

-- DynamoDB Tables
CREATE TABLE IF NOT EXISTS public.vine_dynamodb_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vine_id UUID NOT NULL REFERENCES public.vines(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  table_type public.dynamodb_table_type DEFAULT 'standard',
  hash_key TEXT NOT NULL,
  hash_key_type public.dynamodb_key_type DEFAULT 'S',
  range_key TEXT,
  range_key_type public.dynamodb_key_type,
  billing_mode public.dynamodb_billing_mode DEFAULT 'PAY_PER_REQUEST',
  point_in_time_recovery BOOLEAN DEFAULT true,
  global_replicas TEXT[] DEFAULT '{}',

  status public.component_status NOT NULL DEFAULT 'PENDING',
  status_message TEXT,
  estimated_monthly_cost FLOAT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT vine_dynamodb_name_unique UNIQUE (vine_id, name)
);

-- ECR Container Repositories
CREATE TABLE IF NOT EXISTS public.vine_ecr_repos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vine_id UUID NOT NULL REFERENCES public.vines(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  image_tag_mutability public.ecr_tag_mutability DEFAULT 'MUTABLE',
  scan_on_push BOOLEAN DEFAULT true,

  status public.component_status NOT NULL DEFAULT 'PENDING',
  status_message TEXT,
  repository_url TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT vine_ecr_name_unique UNIQUE (vine_id, name)
);

-- Secrets Manager Entries
CREATE TABLE IF NOT EXISTS public.vine_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vine_id UUID NOT NULL REFERENCES public.vines(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  generate BOOLEAN DEFAULT true,
  length INT DEFAULT 32,
  special_chars BOOLEAN DEFAULT true,

  status public.component_status NOT NULL DEFAULT 'PENDING',
  status_message TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT vine_secrets_name_unique UNIQUE (vine_id, name)
);

-- ============================================================
-- 4. SECURITY: Git credentials (no plaintext tokens)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.vine_git_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vine_id UUID NOT NULL REFERENCES public.vines(id) ON DELETE CASCADE,

  purpose public.git_credential_purpose NOT NULL,
  method public.git_credential_method NOT NULL,
  provider_identity_id UUID,
  secret_ref TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 5. AUDIT LOG
-- ============================================================
CREATE TABLE IF NOT EXISTS public.vine_audit_log (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  vine_id UUID NOT NULL REFERENCES public.vines(id) ON DELETE CASCADE,
  user_id UUID NOT NULL DEFAULT auth.uid(),

  action public.audit_action NOT NULL,
  component_type TEXT,
  component_id UUID,
  changes JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 6. RLS POLICIES (explicit per table)
-- ============================================================

-- Singleton components
ALTER TABLE public.vine_vpc ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own vine_vpc" ON public.vine_vpc
  FOR ALL
  USING (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()))
  WITH CHECK (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()));

ALTER TABLE public.vine_eks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own vine_eks" ON public.vine_eks
  FOR ALL
  USING (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()))
  WITH CHECK (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()));

ALTER TABLE public.vine_dns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own vine_dns" ON public.vine_dns
  FOR ALL
  USING (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()))
  WITH CHECK (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()));

ALTER TABLE public.vine_repositories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own vine_repositories" ON public.vine_repositories
  FOR ALL
  USING (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()))
  WITH CHECK (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()));

-- Multi-instance components
ALTER TABLE public.vine_databases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own vine_databases" ON public.vine_databases
  FOR ALL
  USING (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()))
  WITH CHECK (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()));

ALTER TABLE public.vine_caches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own vine_caches" ON public.vine_caches
  FOR ALL
  USING (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()))
  WITH CHECK (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()));

ALTER TABLE public.vine_queues ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own vine_queues" ON public.vine_queues
  FOR ALL
  USING (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()))
  WITH CHECK (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()));

ALTER TABLE public.vine_topics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own vine_topics" ON public.vine_topics
  FOR ALL
  USING (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()))
  WITH CHECK (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()));

ALTER TABLE public.vine_dynamodb_tables ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own vine_dynamodb_tables" ON public.vine_dynamodb_tables
  FOR ALL
  USING (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()))
  WITH CHECK (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()));

ALTER TABLE public.vine_ecr_repos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own vine_ecr_repos" ON public.vine_ecr_repos
  FOR ALL
  USING (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()))
  WITH CHECK (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()));

ALTER TABLE public.vine_secrets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own vine_secrets" ON public.vine_secrets
  FOR ALL
  USING (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()))
  WITH CHECK (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()));

-- Security tables
ALTER TABLE public.vine_git_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own vine_git_credentials" ON public.vine_git_credentials
  FOR ALL
  USING (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()))
  WITH CHECK (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()));

-- Audit log: read-only for users, workers write via service role
ALTER TABLE public.vine_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own audit logs" ON public.vine_audit_log
  FOR SELECT
  USING (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()));

-- ============================================================
-- 7. UPDATED_AT TRIGGERS
-- ============================================================
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'vine_vpc', 'vine_eks', 'vine_dns', 'vine_repositories',
      'vine_databases', 'vine_caches', 'vine_queues', 'vine_topics',
      'vine_dynamodb_tables', 'vine_ecr_repos', 'vine_secrets'
    ])
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %1$s_updated_at BEFORE UPDATE ON public.%1$I
        FOR EACH ROW EXECUTE FUNCTION public.update_updated_at()',
      tbl
    );
  END LOOP;
END $$;

-- ============================================================
-- 8. ENABLE REALTIME for live status updates
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.vines;
ALTER PUBLICATION supabase_realtime ADD TABLE public.vine_vpc;
ALTER PUBLICATION supabase_realtime ADD TABLE public.vine_eks;
ALTER PUBLICATION supabase_realtime ADD TABLE public.vine_dns;
ALTER PUBLICATION supabase_realtime ADD TABLE public.vine_databases;
ALTER PUBLICATION supabase_realtime ADD TABLE public.vine_caches;
ALTER PUBLICATION supabase_realtime ADD TABLE public.vine_queues;
ALTER PUBLICATION supabase_realtime ADD TABLE public.vine_topics;
ALTER PUBLICATION supabase_realtime ADD TABLE public.vine_dynamodb_tables;
ALTER PUBLICATION supabase_realtime ADD TABLE public.vine_ecr_repos;
ALTER PUBLICATION supabase_realtime ADD TABLE public.vine_secrets;

-- ============================================================
-- 9. BACKWARD COMPATIBILITY VIEW
-- ============================================================
CREATE OR REPLACE VIEW public.vine_full AS
SELECT
  v.id, v.user_id, v.vineyard_id, v.cloud_identity_id,
  v.project_name,
  v.environment_stage::text AS environment_stage,
  v.aws_region, v.aws_account_id,
  v.terraform_version,
  v.status::text AS status,
  v.estimated_monthly_cost,
  v.created_at, v.updated_at,

  -- VPC
  vpc.provision_vpc AS create_vpc,
  vpc.vpc_cidr,
  vpc.vpc_id AS selected_vpc_id,
  vpc.single_nat_gateway,
  vpc.status::text AS vpc_status,

  -- EKS
  eks.cluster_version,
  eks.enable_karpenter,
  eks.cluster_admins,
  eks.instance_types,
  eks.node_min_size,
  eks.node_max_size,
  eks.node_desired_size,
  eks.cluster_name,
  eks.cluster_endpoint,
  eks.status::text AS eks_status,

  -- DNS
  dns.enabled AS enable_dns,
  dns.domain_name AS dns_main_domain,
  dns.hosted_zone_id AS dns_hosted_zone,
  dns.acm_certificate AS acm_certificate_enable,
  dns.cloudfront_waf AS cloudfront_waf_enabled,
  dns.application_waf AS application_waf_enabled,
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

  -- Aggregated from 1:N tables
  EXISTS(SELECT 1 FROM public.vine_databases d WHERE d.vine_id = v.id AND d.status != 'DESTROYED') AS create_rds,
  (SELECT MIN(d.min_capacity) FROM public.vine_databases d WHERE d.vine_id = v.id AND d.status != 'DESTROYED') AS db_min_capacity,
  (SELECT MAX(d.max_capacity) FROM public.vine_databases d WHERE d.vine_id = v.id AND d.status != 'DESTROYED') AS db_max_capacity,
  EXISTS(SELECT 1 FROM public.vine_caches c WHERE c.vine_id = v.id AND c.status != 'DESTROYED') AS enable_redis

FROM public.vines v
LEFT JOIN public.vine_vpc vpc ON vpc.vine_id = v.id
LEFT JOIN public.vine_eks eks ON eks.vine_id = v.id
LEFT JOIN public.vine_dns dns ON dns.vine_id = v.id
LEFT JOIN public.vine_repositories repos ON repos.vine_id = v.id;

-- ============================================================
-- 10. UPDATE provision_jobs to reference vines
-- ============================================================
ALTER TABLE public.provision_jobs ADD COLUMN IF NOT EXISTS vine_id UUID REFERENCES public.vines(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_provision_jobs_vine ON public.provision_jobs(vine_id) WHERE vine_id IS NOT NULL;
