-- Update stale column defaults to match current cloud provider versions.
-- Prevents new rows from getting retired/outdated values when the UI
-- or worker omits a field.

ALTER TABLE public.vine_cluster
  ALTER COLUMN cluster_version SET DEFAULT '1.33';
