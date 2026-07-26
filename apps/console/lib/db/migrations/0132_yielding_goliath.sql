-- The project_full view (programmables.sql) reads project_cluster.cluster_admins, so Postgres would
-- block the column drop. Drop the view first; migrate.mjs re-runs programmables.sql after migrations,
-- which recreates project_full re-sourcing cluster_admins from the cluster_admins child table.
DROP VIEW IF EXISTS public.project_full;--> statement-breakpoint
ALTER TABLE "project_cluster" DROP COLUMN "cluster_admins";