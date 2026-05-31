-- Fix workers table: proper enums, nullable user_id, strict RLS

-- 1. Create enum types
CREATE TYPE public.worker_mode AS ENUM ('self-hosted', 'cloud-hosted');
CREATE TYPE public.worker_status AS ENUM ('ONLINE', 'OFFLINE', 'DRAINING');

-- 2. Drop CHECK constraints on mode and status (inline constraints get auto-named)
ALTER TABLE public.workers DROP CONSTRAINT IF EXISTS workers_mode_check;
ALTER TABLE public.workers DROP CONSTRAINT IF EXISTS workers_status_check;

-- 3. Drop default on status, convert columns to enums, make user_id nullable
ALTER TABLE public.workers
  ALTER COLUMN status DROP DEFAULT;

ALTER TABLE public.workers
  ALTER COLUMN mode TYPE public.worker_mode USING mode::public.worker_mode;

ALTER TABLE public.workers
  ALTER COLUMN status TYPE public.worker_status USING status::public.worker_status;

ALTER TABLE public.workers
  ALTER COLUMN status SET DEFAULT 'OFFLINE'::public.worker_status;

ALTER TABLE public.workers
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.workers
  ALTER COLUMN user_id DROP DEFAULT;

-- 4. Drop all existing RLS policies
DROP POLICY IF EXISTS "Users can view their own workers" ON public.workers;
DROP POLICY IF EXISTS "Users can view cloud-hosted or own workers" ON public.workers;
DROP POLICY IF EXISTS "Users can insert their own workers" ON public.workers;
DROP POLICY IF EXISTS "Users can update their own workers" ON public.workers;
DROP POLICY IF EXISTS "Users can delete their own workers" ON public.workers;
DROP POLICY IF EXISTS "View cloud-hosted or own workers" ON public.workers;
DROP POLICY IF EXISTS "Insert own self-hosted workers only" ON public.workers;
DROP POLICY IF EXISTS "Update own workers only" ON public.workers;
DROP POLICY IF EXISTS "Delete own workers only" ON public.workers;

-- 5. Create new RLS policies (all enum comparisons use explicit casts)
CREATE POLICY "View cloud-hosted or own workers" ON public.workers FOR SELECT
  USING (mode = 'cloud-hosted'::public.worker_mode OR auth.uid() = user_id);

CREATE POLICY "Insert own self-hosted workers only" ON public.workers FOR INSERT
  WITH CHECK (mode = 'self-hosted'::public.worker_mode AND auth.uid() = user_id);

CREATE POLICY "Update own workers only" ON public.workers FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Delete own workers only" ON public.workers FOR DELETE
  USING (auth.uid() = user_id);

-- 6. Recreate RPCs with enum casts
CREATE OR REPLACE FUNCTION public.worker_heartbeat(
    p_worker_id UUID,
    p_worker_token_hash TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.workers
    SET last_heartbeat = now(), status = 'ONLINE'::public.worker_status
    WHERE id = p_worker_id AND token_hash = p_worker_token_hash;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unauthorized worker';
    END IF;
END;
$$;

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
        worker_id = p_worker_id::text,
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
