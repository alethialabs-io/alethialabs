-- Fix cloud_identities: deduplicate, add constraints, DELETE policy, FETCH_RESOURCES job type

-- 1. Deduplicate: keep only the most recent verified (or most recent) per user+provider
DELETE FROM public.cloud_identities
WHERE id NOT IN (
  SELECT DISTINCT ON (user_id, provider) id
  FROM public.cloud_identities
  ORDER BY user_id, provider, is_verified DESC, updated_at DESC NULLS LAST
);

-- 2. One identity per provider per user (prevents future duplicates)
ALTER TABLE public.cloud_identities
  ADD CONSTRAINT cloud_identities_user_provider_unique UNIQUE (user_id, provider);

-- 3. DELETE policy (was missing from original migration)
CREATE POLICY "Users can delete their own identities"
  ON public.cloud_identities FOR DELETE
  USING (auth.uid() = user_id);

-- 4. Convert job_type from CHECK constraint to proper enum
CREATE TYPE public.provision_job_type AS ENUM (
  'BOOTSTRAP', 'DEPLOY', 'DESTROY', 'CONNECTION_TEST', 'FETCH_RESOURCES'
);

ALTER TABLE public.provision_jobs DROP CONSTRAINT IF EXISTS provision_jobs_job_type_check;
ALTER TABLE public.provision_jobs
  ALTER COLUMN job_type TYPE public.provision_job_type USING job_type::public.provision_job_type;
