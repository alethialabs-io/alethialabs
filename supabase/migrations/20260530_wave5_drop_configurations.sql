-- Wave 5: Drop legacy configurations table (replaced by vines + component tables)
DROP FUNCTION IF EXISTS public.get_configuration_stats CASCADE;
ALTER TABLE public.provision_jobs DROP COLUMN IF EXISTS configuration_id;
DROP TABLE IF EXISTS public.configurations CASCADE;
