-- DETECT_DRIFT job type (elench drift posture): a scheduled job that runs
-- `tofu plan -refresh-only -json` for an environment and stores a drift Posture in
-- execution_metadata.drift_posture (packages/core/drift). This is the "keep proving
-- it" half — desired-vs-actual, after apply.
-- Custom migration (db:generate blocked by unrelated pending enum drift in the working
-- tree — same hand-authored ADD VALUE style as 0039/0003). Idempotent.
ALTER TYPE "public"."provision_job_type" ADD VALUE IF NOT EXISTS 'DETECT_DRIFT';
