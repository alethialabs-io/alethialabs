-- Wave 3: Drop legacy Tendril provisions system (replaced by provision_jobs + job_logs)
DROP FUNCTION IF EXISTS public.fetch_next_provision CASCADE;
DROP FUNCTION IF EXISTS public.update_provision_status CASCADE;
DROP FUNCTION IF EXISTS public.insert_provision_log CASCADE;
DROP TABLE IF EXISTS public.provision_logs CASCADE;
DROP TABLE IF EXISTS public.provisions CASCADE;
