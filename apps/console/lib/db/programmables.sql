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

-- ── Push dispatch: wake runners the instant a job becomes claimable, instead of
-- waiting on their poll. Fires on insert and on requeue (status→QUEUED, e.g.
-- recover_stale_jobs). Payload carries identifiers only; connected runners react by
-- calling claim_next_job (FOR UPDATE SKIP LOCKED dedupes the race). ──
CREATE OR REPLACE FUNCTION public.notify_runner_wake()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('runner_wake', json_build_object(
    'job_id', NEW.id,
    'cloud_identity_id', NEW.cloud_identity_id,
    'assigned_runner_id', NEW.assigned_runner_id
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_runner_wake ON public.jobs;
CREATE TRIGGER jobs_runner_wake
  AFTER INSERT OR UPDATE OF status ON public.jobs
  FOR EACH ROW WHEN (NEW.status = 'QUEUED')
  EXECUTE FUNCTION public.notify_runner_wake();

-- ── Queue RPCs (SECURITY DEFINER, token-hash authed). On the renamed
-- jobs/runners tables; runner_id is clean uuid (no ::text casts). ──
-- ── Scheduler quotas (ADR 20). Plan → {priority band, concurrency cap}, read from
-- organization_billing with community as the fallback (no row, or status not live).
-- Authoritative in SQL so claim_next_job enforces them atomically. ──
CREATE OR REPLACE FUNCTION public.org_effective_plan(p_org_id uuid)
RETURNS public.billing_plan LANGUAGE plpgsql STABLE AS $$
DECLARE v public.billing_plan;
BEGIN
  SELECT CASE WHEN ob.status IN ('active', 'trialing') THEN ob.plan
              ELSE 'community'::public.billing_plan END
    INTO v FROM public.organization_billing ob WHERE ob.organization_id = p_org_id;
  RETURN COALESCE(v, 'community'::public.billing_plan);
END;
$$;

CREATE OR REPLACE FUNCTION public.plan_priority(p public.billing_plan)
RETURNS smallint LANGUAGE sql IMMUTABLE AS $$
  SELECT (CASE p WHEN 'enterprise' THEN 30 WHEN 'business' THEN 20
                 WHEN 'team' THEN 10 ELSE 0 END)::smallint;
$$;

-- NULL = unlimited.
CREATE OR REPLACE FUNCTION public.plan_max_concurrency(p public.billing_plan)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p WHEN 'enterprise' THEN NULL WHEN 'business' THEN 20
                WHEN 'team' THEN 8 ELSE 2 END;
$$;

-- Interactive job types jump ahead of batch ones, within the plan band (gap = 10).
CREATE OR REPLACE FUNCTION public.jobtype_priority_bump(jt public.provision_job_type)
RETURNS smallint LANGUAGE sql IMMUTABLE AS $$
  SELECT (CASE jt
    WHEN 'CONNECTION_TEST' THEN 5
    WHEN 'FETCH_RESOURCES' THEN 5
    WHEN 'PLAN' THEN 3
    WHEN 'DEPLOY_RUNNER' THEN 2
    WHEN 'UPDATE_RUNNER' THEN 2
    WHEN 'DESTROY_RUNNER' THEN 2
    ELSE 0 END)::smallint;
$$;

-- An org's in-flight jobs on the SHARED managed pool (the cap + fairness metric).
CREATE OR REPLACE FUNCTION public.org_managed_inflight(p_org_id uuid)
RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::int FROM public.jobs k
  JOIN public.runners r ON r.id = k.runner_id
  WHERE k.org_id = p_org_id
    AND k.status IN ('CLAIMED', 'PROCESSING')
    AND r.operator = 'managed';
$$;

-- Derive provider (denormalized) + priority at insert. Named to fire AFTER
-- jobs_set_org_id (alpha order), so NEW.org_id is populated.
CREATE OR REPLACE FUNCTION public.jobs_set_scheduling()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.provider IS NULL AND NEW.cloud_identity_id IS NOT NULL THEN
    SELECT ci.provider INTO NEW.provider
    FROM public.cloud_identities ci WHERE ci.id = NEW.cloud_identity_id;
  END IF;
  NEW.priority := public.plan_priority(public.org_effective_plan(NEW.org_id))
                  + public.jobtype_priority_bump(NEW.job_type);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_set_scheduling ON public.jobs;
CREATE TRIGGER jobs_set_scheduling BEFORE INSERT ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_set_scheduling();

-- Backfill provider on existing rows (idempotent; old jobs are mostly terminal).
UPDATE public.jobs j SET provider = ci.provider
FROM public.cloud_identities ci
WHERE j.cloud_identity_id = ci.id AND j.provider IS NULL;

CREATE OR REPLACE FUNCTION public.claim_next_job(
    p_runner_id UUID, p_runner_token_hash TEXT, p_cloud_identity_id UUID DEFAULT NULL
) RETURNS SETOF public.jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_job_id UUID;
    v_operator public.runner_operator;
    v_providers public.cloud_provider[];
    v_status public.runner_status;
BEGIN
    SELECT operator, supported_providers, status INTO v_operator, v_providers, v_status FROM public.runners
      WHERE id = p_runner_id AND token_hash = p_runner_token_hash;
    IF v_operator IS NULL THEN
        RAISE EXCEPTION 'Unauthorized runner';
    END IF;
    -- A DRAINING runner (being retired by the fleet controller for a version roll or
    -- scale-down) claims nothing — it finishes its current job, goes idle, gets reaped.
    -- Return before the ONLINE refresh so the drain isn't undone.
    IF v_status = 'DRAINING' THEN
        RETURN;
    END IF;
    UPDATE public.runners SET last_heartbeat = now(), status = 'ONLINE'::public.runner_status WHERE id = p_runner_id;
    PERFORM public.open_runner_session(p_runner_id);

    -- Phase A: jobs explicitly assigned to this runner — highest precedence, priority-ordered.
    UPDATE public.jobs
    SET status = 'CLAIMED', runner_id = p_runner_id, claimed_at = now(), updated_at = now()
    WHERE id = (
        SELECT j.id FROM public.jobs j
        WHERE j.status = 'QUEUED' AND j.assigned_runner_id = p_runner_id
        ORDER BY j.priority DESC, j.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    ) RETURNING id INTO v_job_id;

    -- Phase B: unassigned jobs.
    IF v_job_id IS NULL THEN
        IF v_operator = 'managed' THEN
            -- Shared pool: priority, then fair across orgs (fewest in-flight), then
            -- oldest; skip orgs already at their plan concurrency cap.
            UPDATE public.jobs
            SET status = 'CLAIMED', runner_id = p_runner_id, claimed_at = now(), updated_at = now()
            WHERE id = (
                SELECT j.id FROM public.jobs j
                WHERE j.status = 'QUEUED' AND j.assigned_runner_id IS NULL
                  -- Self-managed token clouds: only the customer's self-hosted runner
                  -- has the credential. A managed runner must never claim these.
                  AND j.requires_self_runner = false
                  AND (p_cloud_identity_id IS NULL OR j.cloud_identity_id = p_cloud_identity_id)
                  AND (v_providers IS NULL OR j.provider IS NULL OR j.provider = ANY(v_providers))
                  AND (
                    public.plan_max_concurrency(public.org_effective_plan(j.org_id)) IS NULL
                    OR public.org_managed_inflight(j.org_id)
                       < public.plan_max_concurrency(public.org_effective_plan(j.org_id))
                  )
                ORDER BY j.priority DESC, public.org_managed_inflight(j.org_id) ASC, j.created_at ASC
                LIMIT 1 FOR UPDATE SKIP LOCKED
            ) RETURNING id INTO v_job_id;
        ELSE
            -- Self/dedicated runner: its own org's jobs; priority then oldest, uncapped.
            UPDATE public.jobs
            SET status = 'CLAIMED', runner_id = p_runner_id, claimed_at = now(), updated_at = now()
            WHERE id = (
                SELECT j.id FROM public.jobs j
                WHERE j.status = 'QUEUED' AND j.assigned_runner_id IS NULL
                  AND (p_cloud_identity_id IS NULL OR j.cloud_identity_id = p_cloud_identity_id)
                  AND (v_providers IS NULL OR j.provider IS NULL OR j.provider = ANY(v_providers))
                ORDER BY j.priority DESC, j.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
            ) RETURNING id INTO v_job_id;
        END IF;
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
    p_runner_id UUID, p_runner_token_hash TEXT, p_version TEXT DEFAULT NULL,
    p_providers public.cloud_provider[] DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_release_id UUID;
BEGIN
    IF p_version IS NOT NULL THEN
        SELECT id INTO v_release_id FROM public.runner_releases WHERE version = p_version;
    END IF;
    -- supported_providers is image-driven: keep it in sync with what the runner
    -- reports (NULL = unset = claims any provider).
    UPDATE public.runners
    SET last_heartbeat = now(), status = 'ONLINE'::public.runner_status,
        version = COALESCE(p_version, version), release_id = COALESCE(v_release_id, release_id),
        supported_providers = COALESCE(p_providers, supported_providers)
    WHERE id = p_runner_id AND token_hash = p_runner_token_hash;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unauthorized runner'; END IF;
    PERFORM public.open_runner_session(p_runner_id);
END;
$$;

-- set_default_runner: owner passed as a parameter (no implicit session-user lookup).
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

-- ── Runner model backfill (legacy `mode` → operator/provisioning) + the
-- data-dependent CHECK constraints. Runs here, after the schema migration adds the
-- columns (operator defaulted to 'self' for all existing rows) and before the
-- constraints are added, so the invariants hold by the time they are enforced.
-- Idempotent: the operator/provisioning UPDATEs are guarded and the constraints
-- are added only if absent. The `mode` column is retained nullable for this
-- window; a later migration drops it. ──
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'runners' AND column_name = 'mode'
  ) THEN
    -- operator: cloud-hosted → managed; self-hosted → self.
    UPDATE public.runners
      SET operator = 'managed'::public.runner_operator
      WHERE mode = 'cloud-hosted' AND operator <> 'managed';
    UPDATE public.runners
      SET operator = 'self'::public.runner_operator
      WHERE mode = 'self-hosted' AND operator <> 'self';
    -- provisioning: legacy self runners with a completed cloud deploy (cloud
    -- identity + deploy_config in metadata) → deployed; otherwise registered.
    -- Managed runners keep NULL.
    UPDATE public.runners
      SET provisioning = CASE
        WHEN cloud_identity_id IS NOT NULL
             AND (metadata -> 'deploy_config') IS NOT NULL
             AND (metadata -> 'deploy_config') <> 'null'::jsonb
          THEN 'deployed'::public.runner_provisioning
        ELSE 'registered'::public.runner_provisioning
      END
      WHERE mode = 'self-hosted' AND provisioning IS NULL;
  END IF;
END $$;

DO $$ BEGIN
  -- managed ⇔ platform-owned (no user).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runners_operator_owner_ck') THEN
    ALTER TABLE public.runners ADD CONSTRAINT runners_operator_owner_ck
      CHECK ((operator = 'managed') = (user_id IS NULL));
  END IF;
  -- provisioning is set iff self-operated.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runners_provisioning_ck') THEN
    ALTER TABLE public.runners ADD CONSTRAINT runners_provisioning_ck
      CHECK ((operator = 'self') = (provisioning IS NOT NULL));
  END IF;
END $$;

-- ── Runner usage metering. Managed runners are billed by provisioned hours, so
-- each ONLINE→OFFLINE interval is recorded as a session row. open_runner_session
-- is called from the ONLINE write paths (claim_next_job, runner_heartbeat);
-- sweep_offline_runners is the close hook (and the only OFFLINE transition). ──
CREATE OR REPLACE FUNCTION public.open_runner_session(p_runner_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Meter managed runners only; open at most one session per runner. The
  -- NOT EXISTS guard (backed by idx_usage_one_open_per_runner) makes re-entrant
  -- claims/heartbeats idempotent.
  INSERT INTO public.runner_usage_sessions (runner_id, operator, org_id, started_at)
  SELECT r.id, r.operator, r.org_id, now()
  FROM public.runners r
  WHERE r.id = p_runner_id AND r.operator = 'managed'
    AND NOT EXISTS (
      SELECT 1 FROM public.runner_usage_sessions s
      WHERE s.runner_id = r.id AND s.ended_at IS NULL);
END;
$$;

-- ── Connection-based presence (instant liveness). The runner holds a persistent SSE
-- wake connection; the route calls runner_present on connect + each ping (refreshing
-- the last_heartbeat lease), and runner_lost the instant the connection drops
-- (req.signal abort). This replaces slow heartbeat-stale polling as the liveness path.
-- A DRAINING runner stays DRAINING (it's being retired) — presence only refreshes the lease. ──
CREATE OR REPLACE FUNCTION public.runner_present(p_runner_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.runners
  SET last_heartbeat = now(),
      status = CASE WHEN status = 'DRAINING' THEN status ELSE 'ONLINE'::public.runner_status END
  WHERE id = p_runner_id;
  PERFORM public.open_runner_session(p_runner_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.runner_lost(p_runner_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Mark gone + close the usage session at the last proof-of-life, and wake the
  -- controller so it replaces the lost capacity without waiting for the next tick.
  WITH closed AS (
    UPDATE public.runners SET status = 'OFFLINE'::public.runner_status
    WHERE id = p_runner_id AND status <> 'OFFLINE'
    RETURNING id, last_heartbeat
  )
  UPDATE public.runner_usage_sessions s
  SET ended_at = COALESCE(c.last_heartbeat, s.started_at),
      duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(c.last_heartbeat, s.started_at) - s.started_at)))::bigint
  FROM closed c WHERE s.runner_id = c.id AND s.ended_at IS NULL;
  PERFORM pg_notify('runner_lost', p_runner_id::text);
END;
$$;

-- Flips stale ONLINE runners to OFFLINE (mirrors recover_stale_jobs's 5-min window)
-- and closes their open session at last_heartbeat (last proof-of-life), so the
-- staleness grace window is not billed. RETURNS the flipped runners so the caller can
-- emit `system.runner.offline` alerts (lib/jobs/recovery.ts) — the state change is the
-- durable signal; emit is best-effort.
-- DROP first: the return type changed (INTEGER → TABLE), which CREATE OR REPLACE can't do.
DROP FUNCTION IF EXISTS public.sweep_offline_runners();
CREATE OR REPLACE FUNCTION public.sweep_offline_runners()
RETURNS TABLE(runner_id uuid, org_id uuid, runner_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
-- The OUT param `org_id` shares a name with the runners column; prefer the column.
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH stale AS (
    UPDATE public.runners
    SET status = 'OFFLINE'::public.runner_status
    WHERE status = 'ONLINE'
      -- Tightened lease: the SSE wake connection refreshes last_heartbeat every ~10s
      -- via runner_present, so a 45s gap means the connection is genuinely gone (hard
      -- partition). Clean drops are caught instantly by runner_lost.
      AND (last_heartbeat IS NULL OR last_heartbeat < now() - INTERVAL '45 seconds')
    RETURNING id, org_id, name, last_heartbeat
  ),
  closed AS (
    UPDATE public.runner_usage_sessions s
    SET ended_at = COALESCE(st.last_heartbeat, s.started_at),
        duration_seconds = GREATEST(
          0,
          EXTRACT(EPOCH FROM (COALESCE(st.last_heartbeat, s.started_at) - s.started_at))
        )::bigint
    FROM stale st
    WHERE s.runner_id = st.id AND s.ended_at IS NULL
    RETURNING s.id
  )
  SELECT st.id, st.org_id, st.name FROM stale st;
END;
$$;

-- ── spec_full: denormalized read model for the CLI config + job-create endpoints.
-- OUTPUT column names match the SpecConfig wire contract (zone_id, create_vpc, …);
-- sources the renamed spec_* tables. Numerics are cast to float8 so the JSON carries
-- numbers (postgres-js otherwise returns numeric as a string). ──
-- DROP first: CREATE OR REPLACE VIEW cannot rename/reorder existing columns
-- (Postgres 42P16), and this view's output columns change as the schema evolves.
DROP VIEW IF EXISTS public.spec_full;
CREATE VIEW public.spec_full AS
SELECT
  s.id, s.user_id, s.zone_id AS zone_id, s.cloud_identity_id,
  s.project_name,
  s.environment_stage::text AS environment_stage,
  s.region,
  ci.provider AS cloud_provider,
  ci.credentials->>'account_id' AS cloud_account_id,
  s.iac_version,
  s.status::text AS status,
  s.estimated_monthly_cost::float8 AS estimated_monthly_cost,
  s.created_at, s.updated_at,

  -- Network
  net.provision_network,
  net.cidr_block,
  net.network_id,
  net.single_nat_gateway,
  net.status::text AS network_status,

  -- Cluster (provider-specific knobs travel in cluster_provider_config)
  cl.cluster_version,
  cl.provider_config AS cluster_provider_config,
  cl.cluster_admins,
  cl.instance_types,
  cl.node_min_size, cl.node_max_size, cl.node_desired_size,
  cl.cluster_name, cl.cluster_endpoint,
  cl.status::text AS cluster_status,

  -- DNS (provider-specific knobs travel in dns_provider_config)
  dns.enabled AS dns_enabled,
  dns.domain_name AS dns_domain_name,
  dns.zone_id AS dns_zone_id,
  dns.managed_certificate AS dns_managed_certificate,
  dns.waf_enabled AS dns_waf_enabled,
  dns.provider_config AS dns_provider_config,
  dns.status::text AS dns_status,

  -- Repositories
  repos.apps_destination_repo,

  -- Aggregated
  EXISTS(SELECT 1 FROM public.spec_databases d WHERE d.spec_id = s.id AND d.status != 'DESTROYED') AS has_database,
  (SELECT MIN(d.min_capacity)::float8 FROM public.spec_databases d WHERE d.spec_id = s.id AND d.status != 'DESTROYED') AS db_min_capacity,
  (SELECT MAX(d.max_capacity)::float8 FROM public.spec_databases d WHERE d.spec_id = s.id AND d.status != 'DESTROYED') AS db_max_capacity,
  EXISTS(SELECT 1 FROM public.spec_caches c WHERE c.spec_id = s.id AND c.status != 'DESTROYED') AS has_cache

FROM public.specs s
LEFT JOIN public.cloud_identities ci ON ci.id = s.cloud_identity_id
LEFT JOIN public.spec_network net ON net.spec_id = s.id
LEFT JOIN public.spec_cluster cl ON cl.spec_id = s.id
LEFT JOIN public.spec_dns dns ON dns.spec_id = s.id
LEFT JOIN public.spec_repositories repos ON repos.spec_id = s.id;

GRANT SELECT ON public.spec_full TO alethia_app;

-- ── org_id coarse-tenancy backfill + trigger. Community: org_id = user_id (the
-- user's personal org); the ee/ Teams build assigns real organization ids. The
-- trigger keeps org_id populated without any insert call-site changes. ──
CREATE OR REPLACE FUNCTION public.set_org_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.org_id IS NULL THEN NEW.org_id = NEW.user_id; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['zones', 'specs', 'cloud_identities', 'connector_credentials', 'jobs', 'runners']) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_set_org_id ON public.%1$I', tbl);
    EXECUTE format(
      'CREATE TRIGGER %1$s_set_org_id BEFORE INSERT ON public.%1$I
         FOR EACH ROW EXECUTE FUNCTION public.set_org_id()', tbl);
    EXECUTE format(
      'UPDATE public.%I SET org_id = user_id WHERE org_id IS NULL AND user_id IS NOT NULL', tbl);
  END LOOP;
END $$;

-- ── Tenant RLS backstop. Coarse org-isolation (org_id = app.current_org) OR'd with
-- the per-owner check (user_id = app.current_owner); both set per-transaction by
-- withScope(). Community: org_id = user_id and current_org = current_owner, so the
-- two are identical — isolation is unchanged. Fine-grained decisions live in the PDP
-- (lib/authz). NULL when unset → deny. Service/superuser bypasses RLS. ──

-- Owned tables (direct user_id + org_id)
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['zones', 'specs', 'jobs', 'agent_threads']) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS owner_all ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL
         USING (user_id = current_setting(''app.current_owner'', true)::uuid
                OR org_id = current_setting(''app.current_org'', true)::uuid)
         WITH CHECK (user_id = current_setting(''app.current_owner'', true)::uuid
                OR org_id = current_setting(''app.current_org'', true)::uuid)', tbl);
  END LOOP;
END $$;

-- Credential tables (scope-aware): a `personal` row is visible only to its author
-- (user_id = current_owner); an `org` row is visible to the whole org
-- (org_id = current_org). This is the coarse blast wall — the fine-grained role
-- (view vs manage) is enforced by the PDP at the app layer (spec/mvp/08 + 07).
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['cloud_identities', 'connector_credentials']) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS owner_all ON public.%I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS scoped_all ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY scoped_all ON public.%I FOR ALL
         USING ((scope = ''personal'' AND user_id = current_setting(''app.current_owner'', true)::uuid)
                OR (scope = ''org'' AND org_id = current_setting(''app.current_org'', true)::uuid))
         WITH CHECK ((scope = ''personal'' AND user_id = current_setting(''app.current_owner'', true)::uuid)
                OR (scope = ''org'' AND org_id = current_setting(''app.current_org'', true)::uuid))', tbl);
  END LOOP;
END $$;

-- runners: managed rows are public-read; writes are owner/org-scoped self runners.
ALTER TABLE public.runners ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS runners_select ON public.runners;
CREATE POLICY runners_select ON public.runners FOR SELECT
  USING (operator = 'managed'::public.runner_operator
         OR user_id = current_setting('app.current_owner', true)::uuid
         OR org_id = current_setting('app.current_org', true)::uuid);
DROP POLICY IF EXISTS runners_insert ON public.runners;
CREATE POLICY runners_insert ON public.runners FOR INSERT
  WITH CHECK (operator = 'self'::public.runner_operator
         AND (user_id = current_setting('app.current_owner', true)::uuid
              OR org_id = current_setting('app.current_org', true)::uuid));
DROP POLICY IF EXISTS runners_update ON public.runners;
CREATE POLICY runners_update ON public.runners FOR UPDATE
  USING (user_id = current_setting('app.current_owner', true)::uuid
         OR org_id = current_setting('app.current_org', true)::uuid);
DROP POLICY IF EXISTS runners_delete ON public.runners;
CREATE POLICY runners_delete ON public.runners FOR DELETE
  USING (user_id = current_setting('app.current_owner', true)::uuid
         OR org_id = current_setting('app.current_org', true)::uuid);

-- Spec child tables (ownership via the parent spec)
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'spec_network', 'spec_cluster', 'spec_dns', 'spec_observability', 'spec_repositories', 'spec_databases',
    'spec_caches', 'spec_queues', 'spec_topics', 'spec_nosql_tables',
    'spec_container_registries', 'spec_secrets', 'spec_git_credentials', 'spec_storage_buckets'
  ]) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS owner_all ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL
         USING (spec_id IN (SELECT id FROM public.specs
                WHERE user_id = current_setting(''app.current_owner'', true)::uuid
                   OR org_id = current_setting(''app.current_org'', true)::uuid))
         WITH CHECK (spec_id IN (SELECT id FROM public.specs
                WHERE user_id = current_setting(''app.current_owner'', true)::uuid
                   OR org_id = current_setting(''app.current_org'', true)::uuid))', tbl);
  END LOOP;
END $$;

-- job_logs + audit_log: user reads own (via parent), runners write via service role.
ALTER TABLE public.job_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS logs_select ON public.job_logs;
CREATE POLICY logs_select ON public.job_logs FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.jobs j
    WHERE j.id = job_logs.job_id
      AND (j.user_id = current_setting('app.current_owner', true)::uuid
           OR j.org_id = current_setting('app.current_org', true)::uuid)));

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_select ON public.audit_log;
CREATE POLICY audit_select ON public.audit_log FOR SELECT
  USING (spec_id IN (SELECT id FROM public.specs
    WHERE user_id = current_setting('app.current_owner', true)::uuid
       OR org_id = current_setting('app.current_org', true)::uuid));

-- profiles: owner = id (CLI/service writes bypass via service role).
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS profile_self ON public.profiles;
CREATE POLICY profile_self ON public.profiles FOR ALL
  USING (id = current_setting('app.current_owner', true)::uuid)
  WITH CHECK (id = current_setting('app.current_owner', true)::uuid);

-- cli_logins: service-role only — RLS enabled with no app policy denies the app role.
ALTER TABLE public.cli_logins ENABLE ROW LEVEL SECURITY;

-- runner_usage_sessions: platform billing data — service-role only (RLS enabled
-- with no app policy denies the app role; access via getServiceDb + the SECURITY
-- DEFINER session functions).
ALTER TABLE public.runner_usage_sessions ENABLE ROW LEVEL SECURITY;

-- Public catalogs: readable by anyone; writes only via service role.
ALTER TABLE public.connectors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS connectors_read ON public.connectors;
CREATE POLICY connectors_read ON public.connectors FOR SELECT USING (true);
ALTER TABLE public.runner_releases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS runner_releases_read ON public.runner_releases;
CREATE POLICY runner_releases_read ON public.runner_releases FOR SELECT USING (true);
