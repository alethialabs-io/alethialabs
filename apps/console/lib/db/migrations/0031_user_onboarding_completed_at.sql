-- Post-signup /welcome setup gate: record when a user finished onboarding. NULL =
-- not yet onboarded (brand-new signups) → routed through /welcome; pre-existing
-- users are backfilled to created_at in programmables.sql. Custom migration
-- (db:generate is blocked by a pre-existing snapshot-history fork — see 0029).
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "onboarding_completed_at" timestamp with time zone;
