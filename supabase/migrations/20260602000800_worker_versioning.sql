-- Worker versioning: track binary version + UPDATE_WORKER job type

-- 1. Add version column to workers table
ALTER TABLE public.workers ADD COLUMN version TEXT;

-- 2. Extend heartbeat RPC to accept and store worker version
CREATE OR REPLACE FUNCTION public.worker_heartbeat(
    p_worker_id UUID,
    p_worker_token_hash TEXT,
    p_version TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.workers
    SET last_heartbeat = now(),
        status = 'ONLINE'::public.worker_status,
        version = COALESCE(p_version, version)
    WHERE id = p_worker_id AND token_hash = p_worker_token_hash;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unauthorized worker';
    END IF;
END;
$$;

-- 3. Add UPDATE_WORKER job type
ALTER TYPE public.provision_job_type ADD VALUE IF NOT EXISTS 'UPDATE_WORKER';
