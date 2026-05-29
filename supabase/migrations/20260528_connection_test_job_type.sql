-- Allow CONNECTION_TEST job type and make vineyard_id nullable for test jobs
ALTER TABLE public.provision_jobs DROP CONSTRAINT IF EXISTS provision_jobs_job_type_check;
ALTER TABLE public.provision_jobs ADD CONSTRAINT provision_jobs_job_type_check
  CHECK (job_type IN ('BOOTSTRAP', 'DEPLOY', 'DESTROY', 'CONNECTION_TEST'));

ALTER TABLE public.provision_jobs ALTER COLUMN vineyard_id DROP NOT NULL;
