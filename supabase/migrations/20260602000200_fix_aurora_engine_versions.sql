-- Update retired Aurora PostgreSQL engine versions to current LTS.
-- AWS retires old minor versions; 14.5 is no longer available.
UPDATE public.vine_databases
SET engine_version = '16.6'
WHERE engine ILIKE '%postgresql%'
  AND engine_version IN ('14.5', '14.6', '14.7', '14.8', '14.9', '14.10', '15.2', '15.3', '15.4');
