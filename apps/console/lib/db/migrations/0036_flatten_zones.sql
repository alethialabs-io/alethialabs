-- Flatten the hierarchy: drop the "zone" layer so a spec = top-level Project under the org.
-- Zones carried no infrastructure (cloud account/region/VPC all live on the spec), so this
-- removes dead structure. Order matters: drop the dependent view/trigger first, then backfill
-- + de-dupe, then the structural drops. Hand-authored (db:generate needs a TTY to confirm the
-- table drop) — matches the snapshot-less style of 0024–0035.

-- 1. Drop objects that depend on the columns we're about to remove (programmables.sql
--    recreates spec_full without zone_id, and no longer creates jobs_sync_zone).
DROP VIEW IF EXISTS public.spec_full;--> statement-breakpoint
DROP TRIGGER IF EXISTS jobs_sync_zone ON public.jobs;--> statement-breakpoint
DROP FUNCTION IF EXISTS public.jobs_sync_zone();--> statement-breakpoint

-- 2. Jobs scope by org_id now (the denormalized zone_id is gone) — ensure it's populated.
UPDATE public.jobs SET org_id = user_id WHERE org_id IS NULL AND user_id IS NOT NULL;--> statement-breakpoint

-- 3. Specs become unique per (org_id, slug) instead of (zone_id, slug). De-dupe any slugs
--    that collide within an org before the new unique constraint is added (append -2, -3, …).
WITH dups AS (
  SELECT id,
         row_number() OVER (PARTITION BY org_id, slug ORDER BY created_at, id) AS rn
  FROM public.specs
  WHERE slug IS NOT NULL
)
UPDATE public.specs s
SET slug = s.slug || '-' || dups.rn
FROM dups
WHERE s.id = dups.id AND dups.rn > 1;--> statement-breakpoint

-- 4. Authz hierarchy: re-point spec→zone edges to spec→org, then drop all zone edges.
INSERT INTO public.resource_hierarchy (child_type, child_id, parent_type, parent_id)
SELECT 'spec', s.id, 'org', s.org_id
FROM public.specs s
WHERE s.org_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.resource_hierarchy rh
    WHERE rh.child_type = 'spec' AND rh.child_id = s.id
      AND rh.parent_type = 'org' AND rh.parent_id = s.org_id
  );--> statement-breakpoint
DELETE FROM public.resource_hierarchy WHERE child_type = 'zone' OR parent_type = 'zone';--> statement-breakpoint

-- 5. Zone-scoped access grants disappear with the zone layer.
DELETE FROM public.grants WHERE resource_type = 'zone';--> statement-breakpoint

-- 6. Structural: drop zone_id (CASCADE clears its FK + the old unique constraint + index),
--    add the per-org unique, and drop the zones table.
ALTER TABLE public.specs DROP COLUMN IF EXISTS zone_id CASCADE;--> statement-breakpoint
ALTER TABLE public.specs ADD CONSTRAINT specs_org_id_slug_key UNIQUE (org_id, slug);--> statement-breakpoint
ALTER TABLE public.jobs DROP COLUMN IF EXISTS zone_id CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.zones CASCADE;
