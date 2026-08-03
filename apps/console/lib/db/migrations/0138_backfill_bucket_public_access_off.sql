-- Data-only backfill. No schema change, so there is no generated snapshot for this entry —
-- same shape as 0139_backfill_registry_switches.sql.
--
-- WHY
--
-- `public_access` has never taken effect on Google Cloud or Azure. GCP fills `uniform_access` on
-- every apply while the Cloud Storage module hardcodes `uniform_bucket_level_access = true`, and
-- Azure sends `container_access_type` into a storage-account module that declares `access_type` —
-- so the value lands on a name nothing reads. On both clouds every bucket has been created
-- PRIVATE regardless of the switch, for the whole life of the setting.
--
-- #1813 wires the switch up. The moment that lands, a bucket whose row says `public_access = true`
-- becomes genuinely, publicly readable on its next deploy — an exposure change nobody asked for at
-- the time it takes effect, arriving as a side effect of a bug fix.
--
-- So the stored `true` is treated as never really chosen: it was recorded against a control that
-- did nothing, and no user has ever seen a public bucket on these two clouds as a result of it.
-- Flip those rows to `false` and let people opt in again knowingly, with a switch that now works.
--
-- ORDERING MATTERS. This must land BEFORE the #1813 carrier fix. Run in this order it is inert —
-- it sets `false` on buckets that are already private in fact. Run after, and there is a window in
-- which containers are public.
--
-- SCOPE. Only GCP and Azure. AWS and Alibaba are untouched deliberately: `public_access` is
-- honored there today, so a user's `true` on those clouds is a real, working, deliberate choice and
-- flipping it would break live static-asset hosting.
--
-- A bucket's cloud is its own `cloud_identity_id` when set, and the project's when NULL (the
-- per-resource placement model in project-components.ts) — resolved here in that order.

UPDATE project_storage_buckets b
SET public_access = false,
    updated_at    = now()
WHERE b.public_access = true
  AND COALESCE(
        (SELECT ci.provider FROM cloud_identities ci WHERE ci.id = b.cloud_identity_id),
        (SELECT ci.provider
           FROM cloud_identities ci
           JOIN projects p ON p.cloud_identity_id = ci.id
          WHERE p.id = b.project_id)
      ) IN ('gcp', 'azure');
