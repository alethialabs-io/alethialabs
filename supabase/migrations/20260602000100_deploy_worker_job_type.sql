-- Add DEPLOY_WORKER job type for provisioning self-hosted worker containers
ALTER TYPE public.provision_job_type ADD VALUE IF NOT EXISTS 'DEPLOY_WORKER';
