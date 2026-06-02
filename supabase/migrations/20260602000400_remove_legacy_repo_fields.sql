-- Remove legacy repo fields — terraform and gitops repos are now platform-managed.
-- Only apps_destination_repo remains for optional user app GitOps.

ALTER TABLE vine_repositories
  DROP COLUMN IF EXISTS env_destination_repo,
  DROP COLUMN IF EXISTS env_template_repo,
  DROP COLUMN IF EXISTS env_template_branch,
  DROP COLUMN IF EXISTS gitops_destination_repo,
  DROP COLUMN IF EXISTS gitops_template_repo,
  DROP COLUMN IF EXISTS gitops_template_branch;
