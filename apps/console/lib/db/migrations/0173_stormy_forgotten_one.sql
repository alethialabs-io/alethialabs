-- 0173: BYO chart admission (#6541) — the environment's enforce setting, and a sticky "this add-on
-- has run here" stamp, backfilled.
--
-- ── Why one statement is hand-inserted ──
--
-- drizzle-kit generated the two ADD COLUMN statements below; they are kept verbatim and in their
-- generated order, and the generated snapshot (meta/0173_snapshot.json) is kept as-is, since it
-- describes the end state. The one UPDATE after them is inserted by hand, per 0141's, 0150's and
-- 0153's convention, because a backfill is data and drizzle-kit does not generate data.
--
-- The backfill stamps `first_observed_running_at` on every row whose CURRENT health is a running
-- state (Healthy, Progressing, Degraded, Suspended — lib/addons/byo-admission.ts RAN_HEALTH), with
-- the time of that read-back when there is one. From then on recordAddonHealth stamps it once, on the
-- first running read, and never clears it. Without the backfill, every chart that ran before this
-- column existed would read as never having run until its next running read-back.
--
-- The migration runs in ONE transaction: the column and its backfill land together or not at all.
ALTER TABLE "project_addons" ADD COLUMN "first_observed_running_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_environments" ADD COLUMN "byo_admission_enforce" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "project_addons"
   SET "first_observed_running_at" = COALESCE("last_synced_at", now())
 WHERE "first_observed_running_at" IS NULL
   AND "health" IN ('Healthy', 'Progressing', 'Degraded', 'Suspended');
