-- Add credential and ARN columns populated after a successful deploy.

ALTER TABLE vine_cluster
  ADD COLUMN IF NOT EXISTS cluster_arn text,
  ADD COLUMN IF NOT EXISTS argocd_url text,
  ADD COLUMN IF NOT EXISTS argocd_admin_password text;

ALTER TABLE vine_databases
  ADD COLUMN IF NOT EXISTS cluster_identifier text,
  ADD COLUMN IF NOT EXISTS cluster_arn text,
  ADD COLUMN IF NOT EXISTS master_credentials_secret_arn text,
  ADD COLUMN IF NOT EXISTS extra_credentials_secret_arn text,
  ADD COLUMN IF NOT EXISTS credentials_kms_key_arn text,
  ADD COLUMN IF NOT EXISTS reader_endpoint text;
