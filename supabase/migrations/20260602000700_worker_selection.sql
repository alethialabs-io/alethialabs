-- Worker selection: default worker flag + job pre-assignment

-- 1. Add is_default column to workers
ALTER TABLE public.workers
  ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT false;

-- Only one default worker per user
CREATE UNIQUE INDEX idx_workers_one_default_per_user
  ON public.workers (user_id)
  WHERE is_default = true;

-- 2. Add assigned_worker_id to provision_jobs
ALTER TABLE public.provision_jobs
  ADD COLUMN assigned_worker_id UUID REFERENCES public.workers(id) ON DELETE SET NULL;

CREATE INDEX idx_provision_jobs_assigned_worker
  ON public.provision_jobs (assigned_worker_id)
  WHERE assigned_worker_id IS NOT NULL;

-- 3. Replace claim_next_job with two-pass logic:
--    Pass 1: jobs assigned to this worker (priority)
--    Pass 2: unassigned jobs (FIFO, respects cloud_identity_id)
DROP FUNCTION IF EXISTS public.claim_next_job(UUID, TEXT, UUID);

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

    -- Pass 1: claim a job explicitly assigned to this worker
    UPDATE public.provision_jobs
    SET status = 'CLAIMED',
        worker_id = p_worker_id,
        claimed_at = now(),
        updated_at = now()
    WHERE id = (
        SELECT pj.id FROM public.provision_jobs pj
        WHERE pj.status = 'QUEUED'
          AND pj.assigned_worker_id = p_worker_id
        ORDER BY pj.created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    )
    RETURNING id INTO v_job_id;

    -- Pass 2: if nothing assigned, claim an unassigned job
    IF v_job_id IS NULL THEN
        UPDATE public.provision_jobs
        SET status = 'CLAIMED',
            worker_id = p_worker_id,
            claimed_at = now(),
            updated_at = now()
        WHERE id = (
            SELECT pj.id FROM public.provision_jobs pj
            WHERE pj.status = 'QUEUED'
              AND pj.assigned_worker_id IS NULL
              AND (p_cloud_identity_id IS NULL OR pj.cloud_identity_id = p_cloud_identity_id)
            ORDER BY pj.created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        RETURNING id INTO v_job_id;
    END IF;

    IF v_job_id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY SELECT * FROM public.provision_jobs WHERE id = v_job_id;
END;
$$;

-- 4. Replace recover_stale_jobs — preserves assigned_worker_id on requeue
DROP FUNCTION IF EXISTS public.recover_stale_jobs();

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

-- 5. RPC to set default worker (one per user)
CREATE OR REPLACE FUNCTION public.set_default_worker(p_worker_id UUID DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Clear existing default for this user
    UPDATE public.workers
    SET is_default = false
    WHERE user_id = auth.uid() AND is_default = true;

    -- Set new default if provided
    IF p_worker_id IS NOT NULL THEN
        UPDATE public.workers
        SET is_default = true
        WHERE id = p_worker_id AND user_id = auth.uid();

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Worker not found or not owned by user';
        END IF;
    END IF;
END;
$$;
