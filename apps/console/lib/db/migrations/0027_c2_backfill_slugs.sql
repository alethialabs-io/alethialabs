-- C2 data migration (hand-authored): backfill URL slugs for existing zones + specs.
-- slug = slugify(name) / slugify(project_name), deduped per scope (org for zones,
-- zone for specs) with -2/-3 suffixes so the unique constraints hold. New rows get
-- their slug from the app (createZone / createSpec).

WITH base AS (
  SELECT
    id,
    org_id,
    NULLIF(
      lower(regexp_replace(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g')),
      ''
    ) AS s,
    created_at
  FROM public.zones
  WHERE slug IS NULL
),
ranked AS (
  SELECT
    id,
    org_id,
    COALESCE(s, 'zone') AS s,
    row_number() OVER (
      PARTITION BY org_id, COALESCE(s, 'zone')
      ORDER BY created_at, id
    ) AS rn
  FROM base
)
UPDATE public.zones z
SET slug = CASE WHEN r.rn = 1 THEN r.s ELSE r.s || '-' || r.rn END
FROM ranked r
WHERE z.id = r.id;
--> statement-breakpoint
WITH base AS (
  SELECT
    id,
    zone_id,
    NULLIF(
      lower(regexp_replace(regexp_replace(project_name, '[^a-zA-Z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g')),
      ''
    ) AS s,
    created_at
  FROM public.specs
  WHERE slug IS NULL
),
ranked AS (
  SELECT
    id,
    zone_id,
    COALESCE(s, 'spec') AS s,
    row_number() OVER (
      PARTITION BY zone_id, COALESCE(s, 'spec')
      ORDER BY created_at, id
    ) AS rn
  FROM base
)
UPDATE public.specs sp
SET slug = CASE WHEN r.rn = 1 THEN r.s ELSE r.s || '-' || r.rn END
FROM ranked r
WHERE sp.id = r.id;
