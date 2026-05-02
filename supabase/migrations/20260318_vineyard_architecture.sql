-- Migration for Vineyard Architecture (v2 - Renaming Provisions to Harvests)

-- 1. Create vineyards table
CREATE TABLE IF NOT EXISTS public.vineyards (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, name)
);

-- 2. Add RLS for vineyards
ALTER TABLE public.vineyards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own vineyards"
    ON public.vineyards FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own vineyards"
    ON public.vineyards FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own vineyards"
    ON public.vineyards FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own vineyards"
    ON public.vineyards FOR DELETE
    USING (auth.uid() = user_id);

-- 3. Update configurations (Vines) and clusters
ALTER TABLE public.configurations
ADD COLUMN vineyard_id UUID REFERENCES public.vineyards(id) ON DELETE CASCADE,
ADD COLUMN ui_position_x FLOAT DEFAULT 0,
ADD COLUMN ui_position_y FLOAT DEFAULT 0;

ALTER TABLE public.clusters
ADD COLUMN vineyard_id UUID REFERENCES public.vineyards(id) ON DELETE SET NULL;

-- 4. Rename provisions to harvests and update schema
-- First, rename the table
ALTER TABLE IF EXISTS public.provisions RENAME TO harvests;

-- Add missing columns to harvests
ALTER TABLE public.harvests
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
ADD COLUMN IF NOT EXISTS configuration_id UUID REFERENCES public.configurations(id) ON DELETE CASCADE,
ADD COLUMN IF NOT EXISTS ui_position_x FLOAT DEFAULT 0,
ADD COLUMN IF NOT EXISTS ui_position_y FLOAT DEFAULT 0,
ADD COLUMN IF NOT EXISTS configuration_hash TEXT;

-- Update RLS for harvests
ALTER TABLE public.harvests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view provisions for their clusters" ON public.harvests;
DROP POLICY IF EXISTS "Users can create provisions for their clusters" ON public.harvests;

CREATE POLICY "Users can view their own harvests"
    ON public.harvests FOR SELECT
    USING (auth.uid() = user_id OR EXISTS (
        SELECT 1 FROM public.clusters 
        WHERE clusters.id = harvests.cluster_id 
        AND clusters.user_id = auth.uid()
    ));

CREATE POLICY "Users can insert their own harvests"
    ON public.harvests FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own harvests"
    ON public.harvests FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own harvests"
    ON public.harvests FOR DELETE
    USING (auth.uid() = user_id);

-- 5. Rename provision_logs to harvest_logs
ALTER TABLE IF EXISTS public.provision_logs RENAME TO harvest_logs;
ALTER TABLE public.harvest_logs RENAME COLUMN provision_id TO harvest_id;

-- Update RLS for harvest_logs
ALTER TABLE public.harvest_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view logs for their provisions" ON public.harvest_logs;

CREATE POLICY "Users can view logs for their harvests"
    ON public.harvest_logs FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.harvests
            JOIN public.clusters ON clusters.id = harvests.cluster_id
            WHERE harvests.id = harvest_logs.harvest_id
            AND clusters.user_id = auth.uid()
        )
    );

-- 6. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_vineyards_user_id ON public.vineyards(user_id);
CREATE INDEX IF NOT EXISTS idx_configurations_vineyard_id ON public.configurations(vineyard_id);
CREATE INDEX IF NOT EXISTS idx_harvests_configuration_id ON public.harvests(configuration_id);
CREATE INDEX IF NOT EXISTS idx_harvests_user_id ON public.harvests(user_id);
CREATE INDEX IF NOT EXISTS idx_harvest_logs_harvest_id ON public.harvest_logs(harvest_id);

-- 7. Data Backfill for Vineyards
DO $$
DECLARE
    user_record RECORD;
    default_vineyard_id UUID;
BEGIN
    FOR user_record IN SELECT DISTINCT user_id FROM public.configurations WHERE vineyard_id IS NULL LOOP
        INSERT INTO public.vineyards (user_id, name, description)
        VALUES (user_record.user_id, 'My First Vineyard', 'Automatically created for existing configurations')
        ON CONFLICT (user_id, name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id INTO default_vineyard_id;

        UPDATE public.configurations
        SET vineyard_id = default_vineyard_id
        WHERE user_id = user_record.user_id AND vineyard_id IS NULL;
    END LOOP;
END $$;

-- 8. Backfill user_id for harvests from clusters
UPDATE public.harvests
SET user_id = clusters.user_id
FROM public.clusters
WHERE harvests.cluster_id = clusters.id AND harvests.user_id IS NULL;

-- 9. Themed RPCs (Harvest Operations)

-- Fetch Next Harvest
CREATE OR REPLACE FUNCTION public.fetch_next_harvest(
  p_cluster_id UUID,
  p_token_hash TEXT
)
RETURNS SETOF public.harvests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.clusters WHERE id = p_cluster_id AND agent_token_hash = p_token_hash) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  SELECT * FROM public.harvests
  WHERE cluster_id = p_cluster_id
    AND status = 'QUEUED'
  ORDER BY created_at ASC
  LIMIT 1;
END;
$$;

-- Update Harvest Status
CREATE OR REPLACE FUNCTION public.update_harvest_status(
  p_cluster_id UUID,
  p_token_hash TEXT,
  p_harvest_id UUID,
  p_status TEXT,
  p_error_message TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Verify agent ownership
  IF NOT EXISTS (SELECT 1 FROM public.clusters WHERE id = p_cluster_id AND agent_token_hash = p_token_hash) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  UPDATE public.harvests
  SET 
    status = p_status,
    error_message = p_error_message,
    started_at = CASE WHEN p_status = 'PROCESSING' THEN NOW() ELSE started_at END,
    completed_at = CASE WHEN p_status IN ('SUCCESS', 'FAILED') THEN NOW() ELSE completed_at END,
    updated_at = NOW()
  WHERE id = p_harvest_id 
    AND cluster_id = p_cluster_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Harvest not found or does not belong to this cluster';
  END IF;
END;
$$;

-- Insert Harvest Logs
CREATE OR REPLACE FUNCTION public.insert_harvest_log(
  p_cluster_id UUID,
  p_token_hash TEXT,
  p_harvest_id UUID,
  p_log_chunk TEXT,
  p_stream_type TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Verify agent ownership
  IF NOT EXISTS (
    SELECT 1 FROM public.harvests h
    JOIN public.clusters c ON c.id = h.cluster_id
    WHERE h.id = p_harvest_id 
      AND c.id = p_cluster_id 
      AND c.agent_token_hash = p_token_hash
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  INSERT INTO public.harvest_logs (harvest_id, log_chunk, stream_type)
  VALUES (p_harvest_id, p_log_chunk, p_stream_type);
END;
$$;

-- Grant access
GRANT EXECUTE ON FUNCTION public.fetch_next_harvest(UUID, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.update_harvest_status(UUID, TEXT, UUID, TEXT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.insert_harvest_log(UUID, TEXT, UUID, TEXT, TEXT) TO anon;
