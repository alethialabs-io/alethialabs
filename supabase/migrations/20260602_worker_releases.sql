-- Worker releases: release catalog with FK from workers

-- 1. Release catalog
CREATE TABLE public.worker_releases (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    version TEXT NOT NULL UNIQUE,
    release_notes TEXT NOT NULL DEFAULT '',
    released_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

ALTER TABLE public.worker_releases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read releases"
    ON public.worker_releases FOR SELECT
    TO authenticated USING (true);

CREATE POLICY "Service role can manage releases"
    ON public.worker_releases FOR ALL
    TO service_role USING (true) WITH CHECK (true);

-- 2. FK from workers to their running release
ALTER TABLE public.workers ADD COLUMN release_id UUID REFERENCES public.worker_releases(id);

-- 3. Update heartbeat RPC to resolve release FK from version string
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
DECLARE
    v_release_id UUID;
BEGIN
    IF p_version IS NOT NULL THEN
        SELECT id INTO v_release_id
        FROM public.worker_releases
        WHERE version = p_version;
    END IF;

    UPDATE public.workers
    SET last_heartbeat = now(),
        status = 'ONLINE'::public.worker_status,
        version = COALESCE(p_version, version),
        release_id = COALESCE(v_release_id, release_id)
    WHERE id = p_worker_id AND token_hash = p_worker_token_hash;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unauthorized worker';
    END IF;
END;
$$;
