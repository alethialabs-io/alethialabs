-- Convert provision_jobs.worker_id from TEXT to UUID with FK to workers.
-- Worker enums (worker_mode, worker_status) already handled by 20260601_fix_workers_schema.sql.
-- This migration only fixes the worker_id column type and FK relationship.

-- Step 1: Drop functions that use worker_id with ::text casts
DROP FUNCTION IF EXISTS public.claim_next_job(UUID, TEXT, UUID);
DROP FUNCTION IF EXISTS public.update_job_status(UUID, TEXT, UUID, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.recover_stale_jobs();

-- Step 2: Drop index on worker_id
DROP INDEX IF EXISTS idx_provision_jobs_worker;

-- Step 3: Convert worker_id TEXT → UUID and add FK
ALTER TABLE public.provision_jobs
  ALTER COLUMN worker_id TYPE UUID USING worker_id::uuid;

-- FK may already exist from another migration — skip if so
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'provision_jobs_worker_id_fkey'
  ) THEN
    ALTER TABLE public.provision_jobs
      ADD CONSTRAINT provision_jobs_worker_id_fkey
      FOREIGN KEY (worker_id) REFERENCES public.workers(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Step 4: Recreate index
CREATE INDEX idx_provision_jobs_worker ON public.provision_jobs(worker_id)
  WHERE worker_id IS NOT NULL;

-- Step 5: Recreate claim_next_job — worker_id is now UUID, no ::text cast
CREATE OR REPLACE FUNCTION public.claim_next_job(
    p_worker_id UUID,
    p_worker_token_hash TEXT,
    p_cloud_identity_id UUID DEFAULT NULL
)
RETURNS SETOF public.provision_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_job_id UUID;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.workers
        WHERE id = p_worker_id AND token_hash = p_worker_token_hash
    ) THEN
        RAISE EXCEPTION 'Unauthorized worker';
    END IF;

    UPDATE public.workers
    SET last_heartbeat = now(), status = 'ONLINE'::public.worker_status
    WHERE id = p_worker_id;

    UPDATE public.provision_jobs
    SET status = 'CLAIMED',
        worker_id = p_worker_id,
        claimed_at = now(),
        updated_at = now()
    WHERE id = (
        SELECT pj.id FROM public.provision_jobs pj
        WHERE pj.status = 'QUEUED'
        AND (p_cloud_identity_id IS NULL OR pj.cloud_identity_id = p_cloud_identity_id)
        ORDER BY pj.created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    )
    RETURNING id INTO v_job_id;

    IF v_job_id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY SELECT * FROM public.provision_jobs WHERE id = v_job_id;
END;
$$;

-- Step 6: Recreate update_job_status — worker_id is UUID, no ::text cast
CREATE OR REPLACE FUNCTION public.update_job_status(
    p_worker_id UUID,
    p_worker_token_hash TEXT,
    p_job_id UUID,
    p_status TEXT,
    p_error_message TEXT DEFAULT NULL,
    p_execution_metadata JSONB DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.workers
        WHERE id = p_worker_id AND token_hash = p_worker_token_hash
    ) THEN
        RAISE EXCEPTION 'Unauthorized worker';
    END IF;

    UPDATE public.provision_jobs
    SET
        status = p_status::public.provision_job_status,
        error_message = COALESCE(p_error_message, error_message),
        execution_metadata = CASE
            WHEN p_execution_metadata IS NOT NULL
            THEN COALESCE(execution_metadata, '{}'::jsonb) || p_execution_metadata
            ELSE execution_metadata
        END,
        started_at = CASE WHEN p_status = 'PROCESSING' AND started_at IS NULL THEN now() ELSE started_at END,
        completed_at = CASE WHEN p_status IN ('SUCCESS', 'FAILED', 'CANCELLED') THEN now() ELSE completed_at END,
        updated_at = now()
    WHERE id = p_job_id
        AND worker_id = p_worker_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Job not found or not owned by this worker';
    END IF;
END;
$$;

-- Step 7: Recreate recover_stale_jobs — worker_id is UUID, direct comparison
CREATE OR REPLACE FUNCTION public.recover_stale_jobs()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    UPDATE public.provision_jobs
    SET status = 'QUEUED',
        worker_id = NULL,
        claimed_at = NULL,
        started_at = NULL,
        updated_at = now()
    WHERE status IN ('CLAIMED', 'PROCESSING')
    AND claimed_at < now() - INTERVAL '15 minutes'
    AND (
        worker_id IS NULL
        OR NOT EXISTS (
            SELECT 1 FROM public.workers w
            WHERE w.id = provision_jobs.worker_id
            AND w.last_heartbeat > now() - INTERVAL '5 minutes'
        )
    );

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- Step 8: Recreate insert_job_log — worker_id is UUID, no ::text cast
CREATE OR REPLACE FUNCTION public.insert_job_log(
    p_worker_id UUID,
    p_worker_token_hash TEXT,
    p_job_id UUID,
    p_log_chunk TEXT,
    p_stream_type TEXT DEFAULT 'STDOUT'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.workers
        WHERE id = p_worker_id AND token_hash = p_worker_token_hash
    ) THEN
        RAISE EXCEPTION 'Unauthorized worker';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.provision_jobs
        WHERE id = p_job_id AND worker_id = p_worker_id
    ) THEN
        RAISE EXCEPTION 'Job not owned by this worker';
    END IF;

    INSERT INTO public.job_logs (job_id, log_chunk, stream_type)
    VALUES (p_job_id, p_log_chunk, p_stream_type);
END;
$$;
