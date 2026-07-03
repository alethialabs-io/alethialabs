-- AUDIT job type (elench "B" flow): a job that runs the verify engine over a customer's
-- EXISTING infrastructure — a bring-your-own OpenTofu/Terraform plan or Kubernetes
-- manifests — and stores the verify.Report in execution_metadata.verify_result (surfaced
-- by the existing get_plan_result tool + VerifyBlock). No infra is provisioned.
-- Hand-authored ADD VALUE (db:generate blocked by working-tree enum drift; same style as
-- 0044/0039). Idempotent.
ALTER TYPE "public"."provision_job_type" ADD VALUE IF NOT EXISTS 'AUDIT';
