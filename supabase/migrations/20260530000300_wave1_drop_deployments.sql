-- Wave 1: Drop legacy deployment tables (no active usage)
DROP TABLE IF EXISTS public.deployment_resources CASCADE;
DROP TABLE IF EXISTS public.deployment_logs CASCADE;
DROP TABLE IF EXISTS public.deployments CASCADE;
