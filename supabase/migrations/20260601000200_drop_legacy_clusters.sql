-- Drop legacy clusters table (replaced by vine_cluster component table)
-- First remove the FK from provision_jobs, then drop the table

ALTER TABLE public.provision_jobs DROP COLUMN IF EXISTS cluster_id;

DROP TABLE IF EXISTS public.clusters CASCADE;
