-- Programmables: least-privilege app role + grants, updated_at
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
    'projects', 'project_environments', 'project_network', 'project_cluster', 'project_dns',
    'project_repositories', 'project_databases', 'project_caches', 'project_queues', 'project_topics',
    'project_nosql_tables', 'project_container_registries', 'project_secrets',
    'project_storage_buckets', 'jobs',
    'environment_protection_rules', 'environment_promotions',
    'support_cases'
  ]) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_updated_at ON public.%1$I', tbl);
    EXECUTE format(
      'CREATE TRIGGER %1$s_updated_at BEFORE UPDATE ON public.%1$I
         FOR EACH ROW EXECUTE FUNCTION public.update_updated_at()', tbl);
  END LOOP;
END $$;

-- Projects are top-level; an earlier per-job consistency trigger + its function are
-- dropped by migration. Jobs scope by org_id.
DROP TRIGGER IF EXISTS jobs_sync_zone ON public.jobs;
DROP FUNCTION IF EXISTS public.jobs_sync_zone();

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
  SELECT (CASE p WHEN 'enterprise' THEN 30
                 WHEN 'team' THEN 10 ELSE 0 END)::smallint;
$$;

-- NULL = unlimited.
CREATE OR REPLACE FUNCTION public.plan_max_concurrency(p public.billing_plan)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p WHEN 'enterprise' THEN NULL
                WHEN 'team' THEN 8 ELSE 2 END;
$$;

-- Interactive job types jump ahead of batch ones, within the plan band (gap = 10).
CREATE OR REPLACE FUNCTION public.jobtype_priority_bump(jt public.provision_job_type)
RETURNS smallint LANGUAGE sql IMMUTABLE AS $$
  SELECT (CASE jt
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
    v_runner_org_id UUID;
BEGIN
    SELECT operator, supported_providers, status, org_id
      INTO v_operator, v_providers, v_status, v_runner_org_id
      FROM public.runners
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
    SET status = 'CLAIMED', runner_id = p_runner_id, claimed_at = now(), progress_at = now(), updated_at = now()
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
            SET status = 'CLAIMED', runner_id = p_runner_id, claimed_at = now(), progress_at = now(), updated_at = now()
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
            -- Self/dedicated runner: STRICTLY its own org's jobs; priority then oldest, uncapped.
            -- The org_id predicate is the cross-tenant guard: without it a self runner
            -- registered with cloud_identity_id omitted and supported_providers unset makes the
            -- cloud_identity/provider filters vacuously true and would claim ANY org's QUEUED job,
            -- leaking that job's decrypted cloud credential to the wrong tenant's runner. A self
            -- runner always has user_id NOT NULL, so runners.org_id backfills (set_org_id trigger)
            -- and is reliably non-null; if it were ever NULL, j.org_id = NULL matches nothing
            -- (fail-closed). Managed runners (org_id NULL, shared pool) must NOT take this branch.
            UPDATE public.jobs
            SET status = 'CLAIMED', runner_id = p_runner_id, claimed_at = now(), progress_at = now(), updated_at = now()
            WHERE id = (
                SELECT j.id FROM public.jobs j
                WHERE j.status = 'QUEUED' AND j.assigned_runner_id IS NULL
                  AND j.org_id = v_runner_org_id
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

-- Recovers stale in-flight jobs, now with a poison-job cap + a progress-stall path. Two staleness
-- signals, evaluated in ONE atomic UPDATE (so the attempts increment can't race a concurrent claim —
-- claim_next_job only touches QUEUED rows FOR UPDATE SKIP LOCKED, and a plain UPDATE row-locks the
-- CLAIMED/PROCESSING rows it matches; a racing second recovery re-checks the WHERE and no-ops):
--
--   (A) DEAD RUNNER (liveness): claimed > 15 min ago AND the runner isn't heartbeating (no
--       last_heartbeat within 5 min, or no runner). The original behaviour.
--   (B) STALLED-BUT-ALIVE (progress): the runner IS heartbeating (alive within 5 min) but has made
--       no real progress for a long time (progress_at older than the 30-min stall threshold — set at
--       claim, refreshed on every stage transition + log flush). A hung-mid-apply runner that the
--       liveness check can never catch. The threshold is deliberately generous and DISTINCT from the
--       5-min liveness window: a live tofu apply prints "Still creating… [Ns elapsed]" every ~10s, so
--       progress_at refreshes constantly — only genuine multi-minute silence trips (B).
--
-- Each recovery INCREMENTS attempts. Below the cap the job is requeued (QUEUED, runner cleared).
-- At the cap (attempts >= max_attempts) it is failed TERMINAL (FAILED + a clear error_message)
-- instead of requeued forever. The function RETURNS the jobs it failed terminally so the caller
-- (lib/jobs/recovery.ts) can drive each one's environment status through the env-status CAS
-- (deployFailed / destroyFailed / planFailed) — a terminal job must not leave its env stuck.
-- Return type changed INTEGER -> TABLE(...): Postgres can't change a function's return type via
-- CREATE OR REPLACE on an existing DB (error 42P13), so drop the old signature first — same pattern as
-- update_job_status / sweep_offline_runners above. IF EXISTS keeps it idempotent on a fresh DB.
DROP FUNCTION IF EXISTS public.recover_stale_jobs();
CREATE OR REPLACE FUNCTION public.recover_stale_jobs()
RETURNS TABLE(job_id UUID, job_type public.provision_job_type, environment_id UUID, org_id UUID, project_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    RETURN QUERY
    WITH updated AS (
        UPDATE public.jobs j
        SET attempts = j.attempts + 1,
            -- At/over the cap → terminal FAILED; otherwise requeue.
            status = CASE WHEN j.attempts + 1 >= j.max_attempts
                          THEN 'FAILED'::public.provision_job_status
                          ELSE 'QUEUED'::public.provision_job_status END,
            -- Requeue clears the claim; a terminal fail keeps runner_id/claimed_at for forensics.
            runner_id  = CASE WHEN j.attempts + 1 >= j.max_attempts THEN j.runner_id  ELSE NULL END,
            claimed_at = CASE WHEN j.attempts + 1 >= j.max_attempts THEN j.claimed_at ELSE NULL END,
            started_at = CASE WHEN j.attempts + 1 >= j.max_attempts THEN j.started_at ELSE NULL END,
            completed_at = CASE WHEN j.attempts + 1 >= j.max_attempts THEN now() ELSE j.completed_at END,
            error_message = CASE WHEN j.attempts + 1 >= j.max_attempts
                THEN 'Job exceeded max attempts (' || j.max_attempts
                     || '): its runner repeatedly died or stalled mid-run. Failed terminally by the '
                     || 'poison-job cap to protect the queue.'
                ELSE j.error_message END,
            updated_at = now()
        WHERE j.status IN ('CLAIMED', 'PROCESSING')
          AND (
            -- (A) dead-runner liveness
            ( j.claimed_at < now() - INTERVAL '15 minutes'
              AND (j.runner_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM public.runners r
                WHERE r.id = j.runner_id AND r.last_heartbeat > now() - INTERVAL '5 minutes')) )
            OR
            -- (B) stalled-but-alive: runner heartbeating, but no forward progress for the stall window
            ( j.runner_id IS NOT NULL
              AND j.progress_at IS NOT NULL
              AND j.progress_at < now() - INTERVAL '30 minutes'
              AND EXISTS (
                SELECT 1 FROM public.runners r
                WHERE r.id = j.runner_id AND r.last_heartbeat > now() - INTERVAL '5 minutes') )
          )
        RETURNING j.id, j.job_type, j.environment_id, j.org_id, j.project_id,
                  (j.status = 'FAILED') AS terminal
    )
    -- Only the terminally-failed jobs need an env-status transition; requeued ones keep their env.
    SELECT u.id, u.job_type, u.environment_id, u.org_id, u.project_id
    FROM updated u
    WHERE u.terminal;
END;
$$;

-- Connection verification is server-side + instant now (no CONNECTION_TEST job), so the old
-- stuck-connection-test sweeper is retired. Drop it from any DB that still has it.
DROP FUNCTION IF EXISTS public.fail_unclaimed_connection_tests(INTERVAL, INTERVAL);

-- Garbage-collect never-saved pending identities. initIdentity() seeds one row per
-- connect-sheet open; abandoned flows leave 'pending' rows forever. Deletes only
-- pending rows that aged out and have NO job at all (a never-saved identity has none);
-- never touches testing/failed/connected. jobs.cloud_identity_id is ON DELETE SET NULL.
CREATE OR REPLACE FUNCTION public.gc_pending_identities(p_age INTERVAL DEFAULT INTERVAL '24 hours')
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count INTEGER;
BEGIN
    DELETE FROM public.cloud_identities ci
    WHERE ci.status = 'pending'
      AND ci.is_verified = false
      AND ci.updated_at < now() - p_age
      AND NOT EXISTS (
        SELECT 1 FROM public.jobs j WHERE j.cloud_identity_id = ci.id
      );
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- Drop the pre-traceparent 5-arg signature so adding the optional p_traceparent
-- param (a new 6-arg overload) doesn't leave an ambiguous stale function behind.
DROP FUNCTION IF EXISTS public.insert_job_log(UUID, TEXT, UUID, TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.insert_job_log(
    p_runner_id UUID, p_runner_token_hash TEXT, p_job_id UUID, p_log_chunk TEXT,
    p_stream_type TEXT DEFAULT 'STDOUT', p_traceparent TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_log_id BIGINT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.runners WHERE id = p_runner_id AND token_hash = p_runner_token_hash) THEN
        RAISE EXCEPTION 'Unauthorized runner';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = p_job_id AND runner_id = p_runner_id) THEN
        RAISE EXCEPTION 'Job not owned by this runner';
    END IF;
    -- Carry the trace on the log line. Fall back to the job's own traceparent when the
    -- runner didn't supply one, so a log always correlates to its trace.
    INSERT INTO public.job_logs (job_id, log_chunk, stream_type, traceparent)
    VALUES (p_job_id, p_log_chunk, p_stream_type::public.log_stream_type,
            COALESCE(p_traceparent, (SELECT traceparent FROM public.jobs WHERE id = p_job_id)))
    RETURNING id INTO v_log_id;
    -- Notify SSE listeners (one LISTEN conn per app instance fans out). IDs only
    -- (8 KB payload cap); the stream route fetches rows since its last seen id.
    PERFORM pg_notify('job_logs', json_build_object('jobId', p_job_id, 'logId', v_log_id)::text);
    -- Progress heartbeat: a log flush is real forward progress. Stamp progress_at so the
    -- stalled-but-alive detector resets — but THROTTLE the write to ≤ once/minute per job so a
    -- chatty apply (log chunks every ~1s) doesn't bloat the jobs row. Minute granularity is ample
    -- against the 30-min stall threshold.
    UPDATE public.jobs
    SET progress_at = now()
    WHERE id = p_job_id
      AND (progress_at IS NULL OR progress_at < now() - INTERVAL '55 seconds');
END;
$$;

-- Return type changed VOID -> BOOLEAN (terminal-state guard). Postgres can't change a function's
-- return type via CREATE OR REPLACE (error 42P13), so drop the old signature first on an existing
-- DB — same as insert_job_log above. IF EXISTS keeps it idempotent on a fresh DB.
DROP FUNCTION IF EXISTS public.update_job_status(UUID, TEXT, UUID, TEXT, TEXT, JSONB);
CREATE OR REPLACE FUNCTION public.update_job_status(
    p_runner_id UUID, p_runner_token_hash TEXT, p_job_id UUID, p_status TEXT,
    p_error_message TEXT DEFAULT NULL, p_execution_metadata JSONB DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.runners WHERE id = p_runner_id AND token_hash = p_runner_token_hash) THEN
        RAISE EXCEPTION 'Unauthorized runner';
    END IF;
    -- Terminal-state guard: never CHANGE an already-terminal status to a DIFFERENT one. This makes a
    -- CANCELLED job STICK — if the console cancelled it (cancelJob) but the pg_notify cancel didn't
    -- reach the runner (wake SSE down) and it ran to completion, the runner's late SUCCESS/FAILED must
    -- NOT revert CANCELLED. A SAME-status re-post IS allowed, so the runner's second CANCELLED post
    -- (which cancelJob's flip precedes) still merges its orphan_risk metadata. Returns whether a row
    -- moved: FALSE = the update was a no-op on an already-terminal job, so the caller must skip the
    -- terminal side-effects (billing / success alert / env→ACTIVE) for that stale callback.
    UPDATE public.jobs
    SET status = p_status::public.provision_job_status,
        error_message = COALESCE(p_error_message, error_message),
        execution_metadata = CASE WHEN p_execution_metadata IS NOT NULL
            THEN COALESCE(execution_metadata, '{}'::jsonb) || p_execution_metadata ELSE execution_metadata END,
        started_at = CASE WHEN p_status = 'PROCESSING' AND started_at IS NULL THEN now() ELSE started_at END,
        -- Progress heartbeat: a status post to PROCESSING is a stage transition = real forward
        -- progress. Stamp progress_at so the stalled-but-alive detector (recover_stale_jobs) resets.
        progress_at = CASE WHEN p_status = 'PROCESSING' THEN now() ELSE progress_at END,
        completed_at = CASE WHEN p_status IN ('SUCCESS', 'FAILED', 'CANCELLED') THEN now() ELSE completed_at END,
        updated_at = now()
    WHERE id = p_job_id AND runner_id = p_runner_id
      AND (status NOT IN ('SUCCESS', 'FAILED', 'CANCELLED')
           OR status = p_status::public.provision_job_status);
    IF FOUND THEN RETURN true; END IF;
    -- Not applied. Distinguish a benign already-terminal job (owned by this runner, the guard blocked
    -- a status CHANGE) from a genuine ownership/existence error. The former returns false (the caller
    -- skips side-effects; the runner learns the job is terminal on its next heartbeat); only the
    -- latter raises.
    IF EXISTS (SELECT 1 FROM public.jobs WHERE id = p_job_id AND runner_id = p_runner_id) THEN
        RETURN false;
    END IF;
    RAISE EXCEPTION 'Job not found or not owned by this runner';
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

-- ── Environment-scoping backfill ───────────────────────────────────────────────────
-- Component config became environment-scoped (environment_id added to every project_* table).
-- Attach any pre-existing rows (created when config was project-level) to their project's
-- DEFAULT environment. Idempotent: only rows whose environment_id is still NULL are touched, so
-- this is safe to re-run on every migrate.
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'project_network', 'project_cluster', 'project_dns', 'project_observability',
    'project_repositories', 'project_databases', 'project_caches', 'project_queues',
    'project_topics', 'project_nosql_tables', 'project_container_registries',
    'project_secrets', 'project_storage_buckets', 'project_git_credentials'
  ]) LOOP
    EXECUTE format(
      'UPDATE public.%I c SET environment_id = e.id
         FROM public.project_environments e
        WHERE e.project_id = c.project_id AND e.is_default
          AND c.environment_id IS NULL', tbl);
  END LOOP;
END $$;

-- ── project_full: denormalized read model for the CLI config + job-create endpoints.
-- OUTPUT column names match the ProjectConfig wire contract (create_vpc, …);
-- sources the renamed project_* tables. Numerics are cast to float8 so the JSON carries
-- numbers (postgres-js otherwise returns numeric as a string). ──
-- DROP first: CREATE OR REPLACE VIEW cannot rename/reorder existing columns
-- (Postgres 42P16), and this view's output columns change as the schema evolves.
DROP VIEW IF EXISTS public.project_full;
CREATE VIEW public.project_full AS
SELECT
  s.id, s.user_id, s.cloud_identity_id,
  s.project_name,
  -- M1: environment identity + provisioning status now live on the project's default
  -- environment (was projects.environment_stage / projects.status). The wire keeps the
  -- `environment_stage` name + emits the env's name (= the old stage for backfilled
  -- projects, so the ProjectConfig.EnvironmentStage → tofu state path is unchanged).
  env.name AS environment_stage,
  s.region,
  ci.provider AS cloud_provider,
  ci.credentials->>'account_id' AS cloud_account_id,
  s.iac_version,
  env.status::text AS status,
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

  -- Aggregated (scoped to the default environment's components)
  EXISTS(SELECT 1 FROM public.project_databases d WHERE d.project_id = s.id AND d.environment_id = env.id AND d.status != 'DESTROYED') AS has_database,
  (SELECT MIN(d.min_capacity)::float8 FROM public.project_databases d WHERE d.project_id = s.id AND d.environment_id = env.id AND d.status != 'DESTROYED') AS db_min_capacity,
  (SELECT MAX(d.max_capacity)::float8 FROM public.project_databases d WHERE d.project_id = s.id AND d.environment_id = env.id AND d.status != 'DESTROYED') AS db_max_capacity,
  EXISTS(SELECT 1 FROM public.project_caches c WHERE c.project_id = s.id AND c.environment_id = env.id AND c.status != 'DESTROYED') AS has_cache

-- The view summarises a project via its DEFAULT environment: `env` is the default env and every
-- component join/aggregate is scoped to it (components are environment-scoped).
FROM public.projects s
LEFT JOIN public.project_environments env ON env.project_id = s.id AND env.is_default = true
LEFT JOIN public.cloud_identities ci ON ci.id = s.cloud_identity_id
LEFT JOIN public.project_network net ON net.project_id = s.id AND net.environment_id = env.id
LEFT JOIN public.project_cluster cl ON cl.project_id = s.id AND cl.environment_id = env.id
LEFT JOIN public.project_dns dns ON dns.project_id = s.id AND dns.environment_id = env.id
LEFT JOIN public.project_repositories repos ON repos.project_id = s.id AND repos.environment_id = env.id;

GRANT SELECT ON public.project_full TO alethia_app;

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
  FOR tbl IN SELECT unnest(ARRAY['projects','cloud_identities', 'connector_credentials', 'jobs', 'runners', 'support_cases', 'thread_widgets', 'agent_artifacts']) LOOP
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
  FOR tbl IN SELECT unnest(ARRAY['projects','jobs', 'agent_threads', 'ai_usage_ledger', 'ai_credit_grant', 'thread_widgets', 'agent_artifacts']) LOOP
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

-- Support cases (tiered): org-owned, but visibility depends on the caller's role. The
-- app sets a third GUC `app.support_all` = 'true' when the caller holds the PDP
-- `support_case:manage_support` capability (owner/admin) — they see EVERY case in the
-- org; everyone else sees only cases they opened (user_id = current_owner). Always
-- org-scoped first (org_id = current_org). `support_all` unset → own-only (fail closed).
-- Community/personal orgs: org_id == user_id == current_owner, so this collapses to
-- exactly today's behavior. WITH CHECK mirrors USING so an admin can update (resolve/
-- reply-bump) a member's case, while the app pins user_id to the requester on insert.
DO $$
BEGIN
  ALTER TABLE public.support_cases ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS owner_all ON public.support_cases;
  CREATE POLICY owner_all ON public.support_cases FOR ALL
    USING (org_id = current_setting('app.current_org', true)::uuid
           AND (coalesce(current_setting('app.support_all', true), '') = 'true'
                OR user_id = current_setting('app.current_owner', true)::uuid))
    WITH CHECK (org_id = current_setting('app.current_org', true)::uuid
           AND (coalesce(current_setting('app.support_all', true), '') = 'true'
                OR user_id = current_setting('app.current_owner', true)::uuid));
END $$;

-- Credential tables (scope-aware): a `personal` row is visible only to its author
-- (user_id = current_owner); an `org` row is visible to the whole org
-- (org_id = current_org). This is the coarse blast wall — the fine-grained role
-- (view vs manage) is enforced by the PDP at the app layer (dataroom/spec/mvp/08 + 07).
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

-- Cloud inventory tables: ownership flows through the parent cloud_identity's scope. Writes come from
-- the console's server-side sync/event-ingester via the service role (RLS-bypassing); this gates tenant
-- reads to identities they own/share.
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'cloud_regions', 'cloud_networks', 'cloud_subnets', 'cloud_nics', 'cloud_dns_zones',
    'cloud_kubernetes_clusters', 'cloud_databases', 'cloud_caches', 'cloud_queues', 'cloud_topics',
    'cloud_nosql_tables', 'cloud_container_registries', 'cloud_secrets', 'cloud_storage_buckets',
    'cloud_resources'
  ]) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS owner_all ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL
         USING (cloud_identity_id IN (
           SELECT id FROM public.cloud_identities ci
            WHERE (ci.scope = ''personal'' AND ci.user_id = current_setting(''app.current_owner'', true)::uuid)
               OR (ci.scope = ''org'' AND ci.org_id = current_setting(''app.current_org'', true)::uuid)))
         WITH CHECK (cloud_identity_id IN (
           SELECT id FROM public.cloud_identities ci
            WHERE (ci.scope = ''personal'' AND ci.user_id = current_setting(''app.current_owner'', true)::uuid)
               OR (ci.scope = ''org'' AND ci.org_id = current_setting(''app.current_org'', true)::uuid)))', tbl);
  END LOOP;
END $$;

-- runners: reads are owner/org-scoped. Managed (platform-fleet) rows have no owner/org, so they
-- are NOT visible through the tenant RLS path — they leak fleet topology/COGS to every tenant
-- otherwise. The fleet controller, scaler, runner claim/heartbeat/wake, and the self-managed
-- operator's fleet view all read managed rows via the service role (getServiceDb), which bypasses
-- RLS. Writes remain owner/org-scoped self runners.
ALTER TABLE public.runners ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS runners_select ON public.runners;
CREATE POLICY runners_select ON public.runners FOR SELECT
  USING (user_id = current_setting('app.current_owner', true)::uuid
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

-- Project child tables (ownership via the parent project)
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'project_environments', 'project_network', 'project_cluster', 'project_dns', 'project_observability', 'project_repositories', 'project_databases',
    'project_caches', 'project_queues', 'project_topics', 'project_nosql_tables',
    'project_container_registries', 'project_secrets', 'project_git_credentials', 'project_storage_buckets',
    'project_changes',
    'environment_protection_rules', 'environment_promotions', 'promotion_approvals'
  ]) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS owner_all ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL
         USING (project_id IN (SELECT id FROM public.projects
                WHERE user_id = current_setting(''app.current_owner'', true)::uuid
                   OR org_id = current_setting(''app.current_org'', true)::uuid))
         WITH CHECK (project_id IN (SELECT id FROM public.projects
                WHERE user_id = current_setting(''app.current_owner'', true)::uuid
                   OR org_id = current_setting(''app.current_org'', true)::uuid))', tbl);
  END LOOP;
END $$;

-- job_logs: user reads own (via parent). audit_log: user reads + inserts own (append-only);
-- runners also write via the RLS-bypassing service role.
ALTER TABLE public.job_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS logs_select ON public.job_logs;
CREATE POLICY logs_select ON public.job_logs FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.jobs j
    WHERE j.id = job_logs.job_id
      AND (j.user_id = current_setting('app.current_owner', true)::uuid
           OR j.org_id = current_setting('app.current_org', true)::uuid)));

-- Support case child tables: tenancy + visibility flow through the parent support_cases
-- (like job_logs) — the subquery uses the SAME tiered predicate (org-scoped, then
-- support_all-or-own), so a reply/attachment/read is visible exactly when its case is.
-- FOR ALL because customers INSERT replies/reads. `is_internal` staff notes ARE visible
-- under this policy, so the customer query builder always filters them out
-- (lib/queries/support.ts) — RLS is the tenancy wall, the query is the visibility filter.
-- Staff writes go through the RLS-bypassing service role, so this policy never needs to
-- permit staff.
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['support_messages','support_case_attachments','support_case_reads']) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS owner_all ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL
         USING (case_id IN (SELECT id FROM public.support_cases
                WHERE org_id = current_setting(''app.current_org'', true)::uuid
                  AND (coalesce(current_setting(''app.support_all'', true), '''') = ''true''
                       OR user_id = current_setting(''app.current_owner'', true)::uuid)))
         WITH CHECK (case_id IN (SELECT id FROM public.support_cases
                WHERE org_id = current_setting(''app.current_org'', true)::uuid
                  AND (coalesce(current_setting(''app.support_all'', true), '''') = ''true''
                       OR user_id = current_setting(''app.current_owner'', true)::uuid)))', tbl);
  END LOOP;
END $$;

-- SSE fan-out: notify listeners on every new thread message (one LISTEN conn per app
-- instance fans out). Payload carries ids only (8 KB cap); the stream route fetches the
-- row since its last seen id. Mirrors insert_job_log's job_logs notify.
CREATE OR REPLACE FUNCTION public.notify_support_message()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('support_messages', json_build_object(
    'caseId', NEW.case_id,
    'messageId', NEW.id
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS support_messages_notify ON public.support_messages;
CREATE TRIGGER support_messages_notify
  AFTER INSERT ON public.support_messages
  FOR EACH ROW EXECUTE FUNCTION public.notify_support_message();

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_select ON public.audit_log;
CREATE POLICY audit_select ON public.audit_log FOR SELECT
  USING (project_id IN (SELECT id FROM public.projects
    WHERE user_id = current_setting('app.current_owner', true)::uuid
       OR org_id = current_setting('app.current_org', true)::uuid));
-- Append-only INSERT for the app role (e.g. createProject's CREATED entry), scoped to owned
-- projects so the write stays inside the same withOwnerScope transaction. No UPDATE/DELETE policy
-- → audit rows are immutable from the app role.
DROP POLICY IF EXISTS audit_insert ON public.audit_log;
CREATE POLICY audit_insert ON public.audit_log FOR INSERT
  WITH CHECK (project_id IN (SELECT id FROM public.projects
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

-- One-time backfill for the post-signup /onboarding gate: mark every user that
-- predates the onboarding flow as already onboarded, so only brand-new signups
-- (created after the cutoff, onboarding_completed_at = NULL) are routed through
-- /onboarding. Cutoff-guarded so this is safe to re-run on every migrate and never
-- touches accounts created after the feature shipped.
UPDATE public."user"
   SET onboarding_completed_at = created_at
 WHERE onboarding_completed_at IS NULL
   AND created_at < TIMESTAMPTZ '2026-06-25 00:00:00+00';

-- Self-heal cloud_identities.status from the legacy is_verified flag (status shipped
-- in 0035). Idempotent: only verified rows still marked anything other than connected.
UPDATE public.cloud_identities
   SET status = 'connected'
 WHERE is_verified = true AND status <> 'connected';

-- ── Structured resource classification (Workstream B) ──────────────────────────────
-- classification_dimension is an "owned" table (has an author, created_by); its coarse
-- tenancy org_id is backfilled from created_by the same way set_org_id backfills owned
-- tables from user_id (community: org_id = author = personal org). The server actions
-- always set org_id explicitly (real orgs), so this trigger is the community fall-back.
CREATE OR REPLACE FUNCTION public.classification_set_org_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.org_id IS NULL THEN NEW.org_id = NEW.created_by; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS classification_dimension_set_org_id ON public.classification_dimension;
CREATE TRIGGER classification_dimension_set_org_id BEFORE INSERT ON public.classification_dimension
  FOR EACH ROW EXECUTE FUNCTION public.classification_set_org_id();
UPDATE public.classification_dimension SET org_id = created_by WHERE org_id IS NULL;

-- Dimensions: coarse org-isolation owner_all (org_id = current_org). No per-user column —
-- classification is org-wide taxonomy, so the blast wall is purely org-scoped; the PDP
-- (org:view / org:edit in the server actions) is the fine-grained gate.
ALTER TABLE public.classification_dimension ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.classification_dimension;
CREATE POLICY owner_all ON public.classification_dimension FOR ALL
  USING (org_id = current_setting('app.current_org', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org', true)::uuid);

-- Values + assignments: child tables whose tenancy flows through the parent dimension
-- (mirrors the project child-table pattern that scopes via public.projects). org_id is
-- also stored denormalized (indexed) but the RLS wall is the parent membership.
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['classification_value','classification_assignment']) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS owner_all ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL
         USING (dimension_id IN (SELECT id FROM public.classification_dimension
                WHERE org_id = current_setting(''app.current_org'', true)::uuid))
         WITH CHECK (dimension_id IN (SELECT id FROM public.classification_dimension
                WHERE org_id = current_setting(''app.current_org'', true)::uuid))', tbl);
  END LOOP;
END $$;

-- ============================================================================
-- E0 tofu-state HTTP-backend locking
-- ----------------------------------------------------------------------------
-- Advisory locks for the console tofu-state proxy (see lib/db/schema/tofu-state.ts).
-- acquire steals only an EXPIRED lock; a steal rotates lock_id + bumps generation, so a
-- slow writer's stale ?ID= is rejected by validate_tofu_state_lock (fencing) → no lost update.
-- SECURITY DEFINER: the service role calls these from runner-authed routes; no direct client access.

CREATE OR REPLACE FUNCTION public.acquire_tofu_state_lock(
    p_state_key TEXT, p_lock_id TEXT, p_job_id UUID, p_info JSONB, p_ttl_seconds INT
) RETURNS TABLE(acquired BOOLEAN, holder JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    INSERT INTO public.tofu_state_locks (state_key, lock_id, generation, job_id, info, locked_at, expires_at)
    VALUES (p_state_key, p_lock_id, 1, p_job_id, p_info, now(), now() + make_interval(secs => p_ttl_seconds))
    ON CONFLICT (state_key) DO UPDATE
        SET lock_id = EXCLUDED.lock_id,
            generation = public.tofu_state_locks.generation + 1,
            job_id = EXCLUDED.job_id,
            info = EXCLUDED.info,
            locked_at = now(),
            expires_at = EXCLUDED.expires_at
        WHERE public.tofu_state_locks.expires_at < now();
    IF FOUND THEN
        acquired := TRUE; holder := NULL; RETURN NEXT; RETURN;
    END IF;
    -- Upsert affected no row → a live lock is held by someone else; report the current holder.
    SELECT FALSE, l.info INTO acquired, holder FROM public.tofu_state_locks l WHERE l.state_key = p_state_key;
    IF NOT FOUND THEN acquired := FALSE; holder := NULL; END IF;
    RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_tofu_state_lock(p_state_key TEXT, p_lock_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    DELETE FROM public.tofu_state_locks WHERE state_key = p_state_key AND lock_id = p_lock_id;
    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_tofu_state_lock(p_state_key TEXT, p_lock_id TEXT)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.tofu_state_locks
        WHERE state_key = p_state_key AND lock_id = p_lock_id AND expires_at > now()
    );
$$;

-- Staff/system-only force-unlock for a stranded state lock (e.g. after a cancelled apply's
-- runner was SIGKILLed before it could UNLOCK). It must NEVER be a naive DELETE: a zombie
-- writer from the killed apply could still be mid-flight, and its state-write POST presents
-- the OLD lock_id as the fencing token. So we ROTATE lock_id (invalidating that fence — the
-- zombie's ?ID= now fails validate_tofu_state_lock) and BUMP the monotonic generation (the
-- same steal invariant acquire_tofu_state_lock uses), then expire the row so a fresh apply
-- can immediately steal it. Returns whether a lock existed for the key. Not a customer action
-- (no alethia_app GRANT) — invoked by the service role from a staff/system path.
CREATE OR REPLACE FUNCTION public.force_release_tofu_state_lock(p_state_key TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    UPDATE public.tofu_state_locks
       SET generation = generation + 1,
           lock_id = 'force-released-' || gen_random_uuid()::text,
           info = COALESCE(info, '{}'::jsonb) || jsonb_build_object('force_released_at', now()),
           expires_at = now() - INTERVAL '1 second'
     WHERE state_key = p_state_key;
    RETURN FOUND;
END;
$$;

-- force_release is a break-glass / operator action, NOT part of the normal tofu-state lock
-- lifecycle (acquire/validate/release). Postgres grants EXECUTE to PUBLIC by default, so without
-- this REVOKE the least-privilege runtime role (alethia_app, used by the RLS + tofu-state-proxy
-- paths) could force-release a live lock and fence a running apply. The superuser service role
-- (getServiceDb → forceReleaseStateLock) owns the function and is unaffected by the revoke.
REVOKE EXECUTE ON FUNCTION public.force_release_tofu_state_lock(TEXT) FROM PUBLIC;

-- Per-VM fleet bootstrap token redemption (E0 0b). Atomic + instance-bound + reusable-within-TTL:
-- the first redeem binds instance_id; the SAME instance may re-redeem (restart / lost-response
-- retry), a DIFFERENT instance or an expired token is rejected (ok=false). Returns the currently
-- linked runner_id (NULL on first use). SECURITY DEFINER: called from the runner-facing bootstrap
-- route; the token is a shared secret only for the one VM it was minted for.
CREATE OR REPLACE FUNCTION public.redeem_bootstrap_token(p_token_hash TEXT, p_instance_id TEXT)
RETURNS TABLE(ok BOOLEAN, runner_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    UPDATE public.runner_bootstrap_tokens t
       SET instance_id = p_instance_id
     WHERE t.token_hash = p_token_hash
       AND t.expires_at > now()
       AND (t.instance_id IS NULL OR t.instance_id IS NOT DISTINCT FROM p_instance_id)
    RETURNING t.runner_id INTO runner_id;
    ok := FOUND;
    RETURN NEXT;
END;
$$;

-- ----------------------------------------------------------------------------
-- Guarded env-status transition (compare-and-swap). EVERY write to
-- project_environments.status routes through here (lib/db/env-status.ts) so a
-- late / racing runner callback can't clobber a newer terminal state
-- (last-writer-wins). A single PK-indexed UPDATE gated on the current status ∈
-- p_expected_from; returns whether a row moved. FALSE = the env wasn't in a legal
-- from-state → the transition was correctly rejected (the TS caller logs + alerts,
-- and for runner callbacks never throws: a lost race must not fail a status PUT).
-- It never raises on a no-op. NOT security-definer — it runs with the caller's RLS
-- (service role bypasses; an owner-scoped tx is policy-checked), matching how the
-- sibling env writes are scoped. p_job_id is carry-through context for the caller's
-- structured log / audit, deliberately not written here.
CREATE OR REPLACE FUNCTION public.set_env_status(
    p_env_id UUID, p_expected_from TEXT[], p_to TEXT, p_job_id UUID DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
    UPDATE public.project_environments
       SET status = p_to::public.project_status, updated_at = now()
     WHERE id = p_env_id
       AND status = ANY (p_expected_from::public.project_status[]);
    RETURN FOUND;
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_env_status(UUID, TEXT[], TEXT, UUID) TO alethia_app;

-- ── Retention GC (B2c reconcile loop) ───────────────────────────────────────────────
-- Bounded, best-effort garbage collection wired into the supervised reconcile loop
-- (lib/reconcile/gc.ts). Each call deletes at most p_limit rows so it can NEVER take a
-- table-wide lock or run long — the loop calls it every tick, so a backlog drains over
-- several passes and then no-ops. FOR UPDATE SKIP LOCKED makes concurrent app instances
-- safe: two loops racing the same window claim disjoint rows instead of blocking.

-- Delete job_logs older than the retention window (default 30d). The oldest rows first
-- (job_logs.id is a monotonic identity, so id-order == insert-order). job_logs has a FK
-- to jobs ON DELETE CASCADE, but we only delete the log rows themselves here.
CREATE OR REPLACE FUNCTION public.gc_job_logs(
    p_age INTERVAL DEFAULT INTERVAL '30 days', p_limit INTEGER DEFAULT 5000
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count INTEGER;
BEGIN
    WITH doomed AS (
        SELECT jl.id
        FROM public.job_logs jl
        WHERE jl.created_at < now() - p_age
        ORDER BY jl.id
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    )
    DELETE FROM public.job_logs jl
    USING doomed d
    WHERE jl.id = d.id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.gc_job_logs(INTERVAL, INTEGER) TO alethia_app;

-- Delete fleet_actions ledger rows older than the retention window (default 90d). The
-- #345 durable fleet-actions ledger has no GC of its own; unbounded it grows forever.
-- Oldest first by created_at; the created_at-leading index (idx_fleet_actions_created_at)
-- serves the range filter + ordered LIMIT as an index scan (the (provider, created_at)
-- index CANNOT — its leading provider column is unconstrained here), keeping the GC cheap.
CREATE OR REPLACE FUNCTION public.gc_fleet_actions(
    p_age INTERVAL DEFAULT INTERVAL '90 days', p_limit INTEGER DEFAULT 5000
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count INTEGER;
BEGIN
    WITH doomed AS (
        SELECT fa.id
        FROM public.fleet_actions fa
        WHERE fa.created_at < now() - p_age
        ORDER BY fa.created_at
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    )
    DELETE FROM public.fleet_actions fa
    USING doomed d
    WHERE fa.id = d.id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.gc_fleet_actions(INTERVAL, INTEGER) TO alethia_app;

-- ── Break-glass (privileged incident recovery) — the most security-sensitive surface ─────────────
-- All three tables are SERVICE-ROLE ONLY: RLS is enabled with NO app policy (the cli_logins /
-- runner_usage_sessions idiom), so the least-privilege alethia_app role — the one behind every
-- customer request and the tofu-state proxy — can neither read nor write them. Break-glass code
-- reaches them exclusively through getServiceDb() behind the ALETHIA_BREAKGLASS_ENABLED +
-- BREAKGLASS_OPERATORS gate. Defense in depth: even if a bug handed alethia_app one of these tables,
-- RLS denies it.
ALTER TABLE public.breakglass_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.breakglass_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.breakglass_approval ENABLE ROW LEVEL SECURITY;

-- breakglass_audit is APPEND-ONLY and must stay immutable even against the service role (a
-- compromised/rogue operator path or a careless migration). The customer audit_log relies on RLS
-- alone (SELECT/INSERT policies, no UPDATE/DELETE) — that only binds the app role, NOT the
-- BYPASSRLS service role that break-glass uses. So we add a trigger-based WORM guard: any UPDATE,
-- DELETE, or TRUNCATE raises, regardless of the caller's role. (A superuser could still deliberately
-- DISABLE the trigger or flip session_replication_role — that is an out-of-band, itself-auditable act,
-- not something reachable from application code; this closes the in-app tamper path.) The append
-- INSERT path is unaffected, so the write-before-act invariant still works.
CREATE OR REPLACE FUNCTION public.breakglass_audit_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'breakglass_audit is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS breakglass_audit_no_mutate ON public.breakglass_audit;
CREATE TRIGGER breakglass_audit_no_mutate
  BEFORE UPDATE OR DELETE ON public.breakglass_audit
  FOR EACH ROW EXECUTE FUNCTION public.breakglass_audit_immutable();

DROP TRIGGER IF EXISTS breakglass_audit_no_truncate ON public.breakglass_audit;
CREATE TRIGGER breakglass_audit_no_truncate
  BEFORE TRUNCATE ON public.breakglass_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.breakglass_audit_immutable();

-- Belt-and-braces: revoke UPDATE/DELETE/TRUNCATE from PUBLIC and the app role outright, so the
-- privilege isn't even granted (the trigger is the hard stop; this removes the grant too).
REVOKE UPDATE, DELETE, TRUNCATE ON public.breakglass_audit FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alethia_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON public.breakglass_audit FROM alethia_app';
    -- The app role has no business touching any break-glass table at all.
    EXECUTE 'REVOKE ALL ON public.breakglass_session, public.breakglass_audit, public.breakglass_approval FROM alethia_app';
  END IF;
END $$;
