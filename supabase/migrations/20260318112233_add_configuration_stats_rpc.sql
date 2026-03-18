-- Migration: Add comprehensive RPC for fetching configuration statistics
-- Description: Provides a highly reliable, single-query stat retrieval for user configurations

CREATE OR REPLACE FUNCTION public.get_configuration_stats()
RETURNS TABLE (
  total_configs bigint,
  draft_configs bigint,
  completed_configs bigint,
  archived_configs bigint,
  failed_configs bigint,
  pending_configs bigint,
  recent_configs bigint,
  this_month_configs bigint,
  eks_configs bigint,
  ecs_configs bigint,
  has_rds_configs bigint,
  has_vpc_configs bigint
)
LANGUAGE plpgsql
SECURITY DEFINER -- Runs as DB admin to ensure consistent metric gathering, but filtered manually
SET search_path = public
AS $$
BEGIN
  -- Security check: Ensure the caller is an authenticated user
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Return the comprehensive statistics in a single row
  RETURN QUERY
  SELECT 
    COUNT(*) AS total_configs,
    
    -- Status breakdown
    COUNT(*) FILTER (WHERE status = 'draft') AS draft_configs,
    COUNT(*) FILTER (WHERE status = 'completed') AS completed_configs,
    COUNT(*) FILTER (WHERE status = 'archived') AS archived_configs,
    COUNT(*) FILTER (WHERE status = 'failed') AS failed_configs,
    COUNT(*) FILTER (WHERE status = 'pending') AS pending_configs,
    
    -- Temporal breakdown
    COUNT(*) FILTER (WHERE created_at > (now() - interval '7 days')) AS recent_configs,
    COUNT(*) FILTER (WHERE date_trunc('month', created_at) = date_trunc('month', now())) AS this_month_configs,
    
    -- Platform breakdown
    COUNT(*) FILTER (WHERE container_platform = 'eks') AS eks_configs,
    COUNT(*) FILTER (WHERE container_platform = 'ecs') AS ecs_configs,

    -- Feature breakdown
    COUNT(*) FILTER (WHERE create_rds = true) AS has_rds_configs,
    COUNT(*) FILTER (WHERE create_vpc = true) AS has_vpc_configs

  FROM public.configurations
  WHERE user_id = auth.uid();
END;
$$;

-- Grant execution to authenticated users
GRANT EXECUTE ON FUNCTION public.get_configuration_stats() TO authenticated;
