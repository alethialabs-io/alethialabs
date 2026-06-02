-- Add PLAN to provision_job_type enum
ALTER TYPE provision_job_type ADD VALUE IF NOT EXISTS 'PLAN';

-- Link DEPLOY jobs back to their originating PLAN job
ALTER TABLE provision_jobs ADD COLUMN IF NOT EXISTS plan_job_id UUID REFERENCES provision_jobs(id);
