-- Wave 2: Drop legacy bootstrap job tables (replaced by provision_jobs)
DROP TABLE IF EXISTS public.bootstrap_logs CASCADE;
DROP TABLE IF EXISTS public.bootstrap_jobs CASCADE;
