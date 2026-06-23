-- M1 data migration (hand-authored; runs between the additive 0019 and the
-- column-drop 0021). Backfills one default environment per spec.
--
-- LOAD-BEARING: the environment `name` is set to the spec's old environment_stage
-- value, so the OpenTofu/S3 state key (zoneID/projectName-<name>-region/tofu.tfstate)
-- stays byte-identical for already-provisioned specs.
INSERT INTO public.spec_environments
  (spec_id, user_id, org_id, name, stage, status, is_default, region, created_at, updated_at)
SELECT
  s.id, s.user_id, s.org_id,
  s.environment_stage::text, s.environment_stage, s.status, true, s.region,
  s.created_at, s.updated_at
FROM public.specs s;
--> statement-breakpoint
-- Map existing spec jobs to their spec's default environment so the per-environment
-- status updates (jobs status endpoint) work for historical / in-flight jobs.
UPDATE public.jobs j
SET environment_id = e.id
FROM public.spec_environments e
WHERE j.spec_id = e.spec_id
  AND e.is_default = true
  AND j.environment_id IS NULL;
--> statement-breakpoint
-- spec_full references specs.environment_stage + specs.status, which 0021 drops.
-- Drop the view here; programmables.sql recreates it (repointed to the default env)
-- at the end of the migrate step.
DROP VIEW IF EXISTS public.spec_full;
