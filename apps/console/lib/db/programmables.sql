-- Programmables: least-privilege app role + grants, updated_at + zone-consistency
-- triggers, the SECURITY DEFINER queue RPCs (token-hash authed; on the renamed
-- jobs/runners tables), and the per-owner RLS backstop. Idempotent — applied via
-- the migrate runner's .unsafe() after the schema migration. Runs as superuser.

-- ── App role (RLS-enforced). Password set by the migrate runner from env. ──
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alethia_app') THEN
    CREATE ROLE alethia_app NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO alethia_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO alethia_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO alethia_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO alethia_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO alethia_app;

-- ── updated_at trigger ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'specs', 'spec_network', 'spec_cluster', 'spec_dns', 'spec_repositories',
    'spec_databases', 'spec_caches', 'spec_queues', 'spec_topics',
    'spec_nosql_tables', 'spec_container_registries', 'spec_secrets',
    'spec_storage_buckets', 'jobs'
  ]) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_updated_at ON public.%1$I', tbl);
    EXECUTE format(
      'CREATE TRIGGER %1$s_updated_at BEFORE UPDATE ON public.%1$I
         FOR EACH ROW EXECUTE FUNCTION public.update_updated_at()', tbl);
  END LOOP;
END $$;

-- ── jobs.zone_id consistency: derive from the spec when a job references one
-- (keeps the denormalized zone_id in sync without a subquery CHECK). ──
CREATE OR REPLACE FUNCTION public.jobs_sync_zone()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.spec_id IS NOT NULL THEN
    SELECT COALESCE(s.zone_id, NEW.zone_id) INTO NEW.zone_id
    FROM public.specs s WHERE s.id = NEW.spec_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_sync_zone ON public.jobs;
CREATE TRIGGER jobs_sync_zone BEFORE INSERT OR UPDATE OF spec_id ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_sync_zone();

-- ── Queue RPCs (SECURITY DEFINER, token-hash authed). On the renamed
-- jobs/runners tables; runner_id is clean uuid (no ::text casts). ──
CREATE OR REPLACE FUNCTION public.claim_next_job(
    p_runner_id UUID, p_runner_token_hash TEXT, p_cloud_identity_id UUID DEFAULT NULL
) RETURNS SETOF public.jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job_id UUID;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.runners WHERE id = p_runner_id AND token_hash = p_runner_token_hash) THEN
        RAISE EXCEPTION 'Unauthorized runner';
    END IF;
    UPDATE public.runners SET last_heartbeat = now(), status = 'ONLINE'::public.worker_status WHERE id = p_runner_id;
    UPDATE public.jobs
    SET status = 'CLAIMED', runner_id = p_runner_id, claimed_at = now(), updated_at = now()
    WHERE id = (
        SELECT j.id FROM public.jobs j
        WHERE j.status = 'QUEUED' AND j.assigned_runner_id = p_runner_id
        ORDER BY j.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    ) RETURNING id INTO v_job_id;
    IF v_job_id IS NULL THEN
        UPDATE public.jobs
        SET status = 'CLAIMED', runner_id = p_runner_id, claimed_at = now(), updated_at = now()
        WHERE id = (
            SELECT j.id FROM public.jobs j
            WHERE j.status = 'QUEUED' AND j.assigned_runner_id IS NULL
              AND (p_cloud_identity_id IS NULL OR j.cloud_identity_id = p_cloud_identity_id)
            ORDER BY j.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
        ) RETURNING id INTO v_job_id;
    END IF;
    IF v_job_id IS NULL THEN RETURN; END IF;
    RETURN QUERY SELECT * FROM public.jobs WHERE id = v_job_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.recover_stale_jobs()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count INTEGER;
BEGIN
    UPDATE public.jobs
    SET status = 'QUEUED', runner_id = NULL, claimed_at = NULL, started_at = NULL, updated_at = now()
    WHERE status IN ('CLAIMED', 'PROCESSING')
      AND claimed_at < now() - INTERVAL '15 minutes'
      AND (runner_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.runners r
        WHERE r.id = jobs.runner_id AND r.last_heartbeat > now() - INTERVAL '5 minutes'
      ));
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.insert_job_log(
    p_runner_id UUID, p_runner_token_hash TEXT, p_job_id UUID, p_log_chunk TEXT, p_stream_type TEXT DEFAULT 'STDOUT'
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_log_id BIGINT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.runners WHERE id = p_runner_id AND token_hash = p_runner_token_hash) THEN
        RAISE EXCEPTION 'Unauthorized runner';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = p_job_id AND runner_id = p_runner_id) THEN
        RAISE EXCEPTION 'Job not owned by this runner';
    END IF;
    INSERT INTO public.job_logs (job_id, log_chunk, stream_type)
    VALUES (p_job_id, p_log_chunk, p_stream_type::public.log_stream_type)
    RETURNING id INTO v_log_id;
    -- Notify SSE listeners (one LISTEN conn per app instance fans out). IDs only
    -- (8 KB payload cap); the stream route fetches rows since its last seen id.
    PERFORM pg_notify('job_logs', json_build_object('jobId', p_job_id, 'logId', v_log_id)::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.update_job_status(
    p_runner_id UUID, p_runner_token_hash TEXT, p_job_id UUID, p_status TEXT,
    p_error_message TEXT DEFAULT NULL, p_execution_metadata JSONB DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.runners WHERE id = p_runner_id AND token_hash = p_runner_token_hash) THEN
        RAISE EXCEPTION 'Unauthorized runner';
    END IF;
    UPDATE public.jobs
    SET status = p_status::public.provision_job_status,
        error_message = COALESCE(p_error_message, error_message),
        execution_metadata = CASE WHEN p_execution_metadata IS NOT NULL
            THEN COALESCE(execution_metadata, '{}'::jsonb) || p_execution_metadata ELSE execution_metadata END,
        started_at = CASE WHEN p_status = 'PROCESSING' AND started_at IS NULL THEN now() ELSE started_at END,
        completed_at = CASE WHEN p_status IN ('SUCCESS', 'FAILED', 'CANCELLED') THEN now() ELSE completed_at END,
        updated_at = now()
    WHERE id = p_job_id AND runner_id = p_runner_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Job not found or not owned by this runner'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.runner_heartbeat(
    p_runner_id UUID, p_runner_token_hash TEXT, p_version TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_release_id UUID;
BEGIN
    IF p_version IS NOT NULL THEN
        SELECT id INTO v_release_id FROM public.runner_releases WHERE version = p_version;
    END IF;
    UPDATE public.runners
    SET last_heartbeat = now(), status = 'ONLINE'::public.worker_status,
        version = COALESCE(p_version, version), release_id = COALESCE(v_release_id, release_id)
    WHERE id = p_runner_id AND token_hash = p_runner_token_hash;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unauthorized runner'; END IF;
END;
$$;

-- set_default_runner: owner passed as a parameter (no auth.uid() off Supabase).
CREATE OR REPLACE FUNCTION public.set_default_runner(p_user_id UUID, p_runner_id UUID DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    UPDATE public.runners SET is_default = false WHERE user_id = p_user_id AND is_default = true;
    IF p_runner_id IS NOT NULL THEN
        UPDATE public.runners SET is_default = true WHERE id = p_runner_id AND user_id = p_user_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Runner not found or not owned by user'; END IF;
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_default_runner(UUID, UUID) TO alethia_app;

-- ── spec_full: denormalized read model for the CLI config + job-create endpoints.
-- Mirrors the legacy vine_full OUTPUT column names exactly (vineyard_id, create_vpc,
-- …) so the Go wire contract holds; sources the renamed spec_* tables. Numerics are
-- cast to float8 so the JSON carries numbers (matching the old PostgREST output;
-- postgres-js otherwise returns numeric as a string). ──
CREATE OR REPLACE VIEW public.spec_full AS
SELECT
  s.id, s.user_id, s.zone_id AS vineyard_id, s.cloud_identity_id,
  s.project_name,
  s.environment_stage::text AS environment_stage,
  s.region,
  s.region AS aws_region,
  ci.provider AS cloud_provider,
  ci.credentials->>'account_id' AS aws_account_id,
  s.terraform_version,
  s.status::text AS status,
  s.estimated_monthly_cost::float8 AS estimated_monthly_cost,
  s.created_at, s.updated_at,

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
  EXISTS(SELECT 1 FROM public.spec_databases d WHERE d.spec_id = s.id AND d.status != 'DESTROYED') AS create_rds,
  (SELECT MIN(d.min_capacity)::float8 FROM public.spec_databases d WHERE d.spec_id = s.id AND d.status != 'DESTROYED') AS db_min_capacity,
  (SELECT MAX(d.max_capacity)::float8 FROM public.spec_databases d WHERE d.spec_id = s.id AND d.status != 'DESTROYED') AS db_max_capacity,
  EXISTS(SELECT 1 FROM public.spec_caches c WHERE c.spec_id = s.id AND c.status != 'DESTROYED') AS enable_redis

FROM public.specs s
LEFT JOIN public.cloud_identities ci ON ci.id = s.cloud_identity_id
LEFT JOIN public.spec_network net ON net.spec_id = s.id
LEFT JOIN public.spec_cluster cl ON cl.spec_id = s.id
LEFT JOIN public.spec_dns dns ON dns.spec_id = s.id
LEFT JOIN public.spec_repositories repos ON repos.spec_id = s.id;

GRANT SELECT ON public.spec_full TO alethia_app;

-- ── Per-owner RLS backstop. current_setting('app.current_owner', true) is set
-- per-transaction by withOwnerScope(); NULL when unset → deny. Service/superuser
-- bypasses RLS; the app role is constrained. ──

-- Owned tables (direct user_id)
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['zones', 'specs', 'cloud_identities', 'jobs']) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS owner_all ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL
         USING (user_id = current_setting(''app.current_owner'', true)::uuid)
         WITH CHECK (user_id = current_setting(''app.current_owner'', true)::uuid)', tbl);
  END LOOP;
END $$;

-- runners: cloud-hosted rows are public-read; writes are owner-scoped.
ALTER TABLE public.runners ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS runners_select ON public.runners;
CREATE POLICY runners_select ON public.runners FOR SELECT
  USING (mode = 'cloud-hosted'::public.worker_mode OR user_id = current_setting('app.current_owner', true)::uuid);
DROP POLICY IF EXISTS runners_insert ON public.runners;
CREATE POLICY runners_insert ON public.runners FOR INSERT
  WITH CHECK (mode = 'self-hosted'::public.worker_mode AND user_id = current_setting('app.current_owner', true)::uuid);
DROP POLICY IF EXISTS runners_update ON public.runners;
CREATE POLICY runners_update ON public.runners FOR UPDATE
  USING (user_id = current_setting('app.current_owner', true)::uuid);
DROP POLICY IF EXISTS runners_delete ON public.runners;
CREATE POLICY runners_delete ON public.runners FOR DELETE
  USING (user_id = current_setting('app.current_owner', true)::uuid);

-- Spec child tables (ownership via the parent spec)
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'spec_network', 'spec_cluster', 'spec_dns', 'spec_repositories', 'spec_databases',
    'spec_caches', 'spec_queues', 'spec_topics', 'spec_nosql_tables',
    'spec_container_registries', 'spec_secrets', 'spec_git_credentials', 'spec_storage_buckets'
  ]) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS owner_all ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL
         USING (spec_id IN (SELECT id FROM public.specs WHERE user_id = current_setting(''app.current_owner'', true)::uuid))
         WITH CHECK (spec_id IN (SELECT id FROM public.specs WHERE user_id = current_setting(''app.current_owner'', true)::uuid))', tbl);
  END LOOP;
END $$;

-- job_logs + audit_log: user reads own (via parent), runners write via service role.
ALTER TABLE public.job_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS logs_select ON public.job_logs;
CREATE POLICY logs_select ON public.job_logs FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.jobs j
    WHERE j.id = job_logs.job_id AND j.user_id = current_setting('app.current_owner', true)::uuid));

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_select ON public.audit_log;
CREATE POLICY audit_select ON public.audit_log FOR SELECT
  USING (spec_id IN (SELECT id FROM public.specs WHERE user_id = current_setting('app.current_owner', true)::uuid));

-- profiles: owner = id (CLI/service writes bypass via service role).
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS profile_self ON public.profiles;
CREATE POLICY profile_self ON public.profiles FOR ALL
  USING (id = current_setting('app.current_owner', true)::uuid)
  WITH CHECK (id = current_setting('app.current_owner', true)::uuid);

-- cli_logins: service-role only — RLS enabled with no app policy denies the app role.
ALTER TABLE public.cli_logins ENABLE ROW LEVEL SECURITY;

-- Public catalogs: readable by anyone; writes only via service role.
ALTER TABLE public.connectors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS connectors_read ON public.connectors;
CREATE POLICY connectors_read ON public.connectors FOR SELECT USING (true);
ALTER TABLE public.runner_releases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS runner_releases_read ON public.runner_releases;
CREATE POLICY runner_releases_read ON public.runner_releases FOR SELECT USING (true);
