-- 0140 data migration (hand-authored): carry the registry switches out of provider_config.
--
-- Data-only, so there is no generated snapshot for this entry — same shape as
-- 0138_backfill_bucket_public_access_off.sql.
--
-- 0139 added `immutable_tags` and `vulnerability_scanning` as typed columns on
-- project_container_registries, both DEFAULT true. Without this file that is a silent data loss:
-- every row already holding a value in `provider_config` would keep it there, unread, while the
-- new column reported the default — so a user who had turned image scanning OFF would find it
-- reported ON, and (now that the switch is actually carried to the cloud) would get it built ON.
--
-- Three statements, in this order:
--
--   1/2. Copy an EXPLICIT value across. Only rows that hold the key are touched, so a row that
--        never had one keeps the column default of true. That default is the correct reading of
--        history rather than a guess: nothing carried these switches to any cloud before #1811, and
--        every template's own default was the safe setting (ECR builds IMMUTABLE with scan-on-push),
--        so an absent key describes a repository that was built with both ON.
--
--        A row that holds `false` is a user who toggled the switch off — the canvas only ever wrote
--        the key on interaction. That choice is honored, and it is worth being explicit that it now
--        MEANS something: the next apply will set that repository's tags mutable, or turn scanning
--        off, where before the value sat in the database and reached no cloud. That is the point of
--        the change, and it is an in-place update on ECR / Artifact Registry / CR — no repository is
--        replaced and no image is lost.
--
--   3.   Strip both keys from the JSONB. One source of truth: a stale copy left behind would be a
--        second answer to the same question, and the validator that used to shape it no longer
--        accepts either key. The remaining keys (registry_url, namespace, the *-xacct references)
--        are untouched.
--
-- `provider_config->>'key' IS NOT NULL` rather than the `?` containment operator on purpose: `?` is
-- the parameter placeholder in several drivers and does not survive every migration runner intact.
-- A NULL `provider_config` answers NULL to `->>`, so those rows are excluded by all three WHEREs
-- and keep the column default, which is what they should have.

UPDATE project_container_registries
SET immutable_tags = (provider_config->>'immutable_tags')::boolean
WHERE provider_config->>'immutable_tags' IS NOT NULL;
--> statement-breakpoint
UPDATE project_container_registries
SET vulnerability_scanning = (provider_config->>'vulnerability_scanning')::boolean
WHERE provider_config->>'vulnerability_scanning' IS NOT NULL;
--> statement-breakpoint
UPDATE project_container_registries
SET provider_config = (provider_config - 'immutable_tags') - 'vulnerability_scanning'
WHERE provider_config->>'immutable_tags' IS NOT NULL
   OR provider_config->>'vulnerability_scanning' IS NOT NULL;
