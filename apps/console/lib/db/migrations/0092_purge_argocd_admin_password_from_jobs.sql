-- Custom SQL migration file, put your code below! --

-- Purge historical plaintext ArgoCD admin passwords from jobs.execution_metadata.
-- Every pre-fix DEPLOY job persisted the password under the top-level
-- 'argocd_admin_password' key, and argocd-initial-admin-secret is never rotated,
-- so those are LIVE credentials sitting in job history (exposed via getPlanResult /
-- getProjectJobs, cross-tenant support reads, and DB backups). The runner no longer
-- posts the key and the console ingest scrub drops it, but stored history must be
-- scrubbed too. jsonb '-' deletes the key; the WHERE keeps this a no-op-fast pass
-- over jobs that never carried it.
UPDATE jobs
SET execution_metadata = execution_metadata - 'argocd_admin_password'
WHERE execution_metadata ? 'argocd_admin_password';
