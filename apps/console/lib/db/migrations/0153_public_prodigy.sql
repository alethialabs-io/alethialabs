-- 0153: the project component family gets a tenant column (#4116) — add it, derive it, backfill
-- it, then make NULL unstorable.
--
-- ── Why this file is hand-ordered ──
--
-- drizzle-kit generated two blocks from the schema: twenty `ADD COLUMN "org_id" uuid` (project_changes
-- already had the column) followed by twenty-one `CHECK ("org_id" IS NOT NULL)`. On a populated
-- database the CHECKs fail, correctly: every existing row has a NULL `org_id` until something fills
-- it. So the generated statements are kept verbatim and in their generated order, and the steps
-- that fill the column are placed BETWEEN the two blocks.
--
-- The generated snapshot (meta/0153_snapshot.json) is kept as-is: it describes the END state, which
-- is what this file arrives at. Only statements were inserted — per 0141's and 0150's convention.
--
-- Each migration runs in ONE transaction, so if any CHECK below finds a NULL the whole file rolls
-- back and no table is left with a half-populated tenant column.
--
-- ── Why the trigger is created HERE and not only in programmables.sql ──
--
-- scripts/migrate.mjs applies the migrations FIRST and programmables.sql AFTER, in a separate
-- statement. Between the two, the CHECKs below are live and nothing yet fills `org_id` — and any
-- console process still serving the previous build at that moment inserts component rows without
-- one (no app code writes this column). Creating the
-- derivation trigger in this transaction closes that window: there is no instant at which the CHECK
-- exists and the trigger does not. programmables.sql re-creates the SAME function and triggers on
-- every migrate (it is the file that owns them from then on), so this copy lives only until the
-- programmables step that immediately follows it.

-- ── Generated: the columns. ──
ALTER TABLE "project_addons" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "project_caches" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "project_chart_workloads" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "project_cluster" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "project_container_registries" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "project_databases" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "project_dns" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "project_git_credentials" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "project_helm_registries" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "project_iac_sources" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "project_network" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "project_nosql_tables" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "project_observability" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "project_queues" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "project_repositories" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "project_secrets" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "project_services" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "project_source_repos" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "project_storage_buckets" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "project_topics" ADD COLUMN "org_id" uuid;--> statement-breakpoint

-- ── Step 1: projects.org_id, the value being copied, must itself be present. ──
--
-- The SAME expression 0150 Step 1 and programmables.sql's set_org_id loop use, so the three cannot
-- disagree. `projects.user_id` is NOT NULL, so after this no project has a NULL org and Step 3 has a
-- value to copy for every component row. Idempotent: after 0150 it matches nothing.
UPDATE public.projects SET org_id = user_id WHERE org_id IS NULL AND user_id IS NOT NULL;
--> statement-breakpoint

-- ── Step 2: the derivation, installed before any row is filled. ──
--
-- Identical to programmables.sql's `derive_component_org_id` — read the rationale there. In short:
-- org_id is OVERWRITTEN from the parent on every insert and every change of project_id/org_id, so
-- the app can neither forget it nor stamp a wrong one, and it raises rather than store a NULL.
CREATE OR REPLACE FUNCTION public.derive_component_org_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  NEW.org_id := (SELECT p.org_id FROM public.projects p WHERE p.id = NEW.project_id);
  IF NEW.org_id IS NULL THEN
    RAISE EXCEPTION 'cannot derive %.org_id: project % does not exist or has no org',
      TG_TABLE_NAME, NEW.project_id
      USING ERRCODE = 'not_null_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'project_addons',
    'project_caches',
    'project_changes',
    'project_chart_workloads',
    'project_cluster',
    'project_container_registries',
    'project_databases',
    'project_dns',
    'project_git_credentials',
    'project_helm_registries',
    'project_iac_sources',
    'project_network',
    'project_nosql_tables',
    'project_observability',
    'project_queues',
    'project_repositories',
    'project_secrets',
    'project_services',
    'project_source_repos',
    'project_storage_buckets',
    'project_topics'
  ]) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_set_org_id ON public.%1$I', tbl);
    EXECUTE format(
      'CREATE TRIGGER %1$s_set_org_id BEFORE INSERT OR UPDATE OF project_id, org_id ON public.%1$I
         FOR EACH ROW EXECUTE FUNCTION public.derive_component_org_id()', tbl);
  END LOOP;
END $$;
--> statement-breakpoint

-- ── Step 3: backfill every existing row from its project. ──
--
-- `IS DISTINCT FROM`, not `IS NULL`, so this also corrects project_changes, whose pre-existing
-- `org_id` column was never written by the app (app/server/actions/staged-changes.ts stamps no org)
-- — every row it holds is NULL today, and any that is not is overwritten with the parent's org.
-- The UPDATE fires the Step 2 trigger, which derives the same value; the explicit SET is what makes
-- this step readable without knowing that.
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'project_addons',
    'project_caches',
    'project_changes',
    'project_chart_workloads',
    'project_cluster',
    'project_container_registries',
    'project_databases',
    'project_dns',
    'project_git_credentials',
    'project_helm_registries',
    'project_iac_sources',
    'project_network',
    'project_nosql_tables',
    'project_observability',
    'project_queues',
    'project_repositories',
    'project_secrets',
    'project_services',
    'project_source_repos',
    'project_storage_buckets',
    'project_topics'
  ]) LOOP
    EXECUTE format(
      'UPDATE public.%I c SET org_id = p.org_id
         FROM public.projects p
        WHERE p.id = c.project_id AND c.org_id IS DISTINCT FROM p.org_id', tbl);
  END LOOP;
END $$;
--> statement-breakpoint

-- ── Step 4 (generated): NULL becomes unstorable. ──
ALTER TABLE "project_addons" ADD CONSTRAINT "project_addons_org_id_nn" CHECK ("project_addons"."org_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "project_caches" ADD CONSTRAINT "project_caches_org_id_nn" CHECK ("project_caches"."org_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "project_changes" ADD CONSTRAINT "project_changes_org_id_nn" CHECK ("project_changes"."org_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "project_chart_workloads" ADD CONSTRAINT "project_chart_workloads_org_id_nn" CHECK ("project_chart_workloads"."org_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "project_cluster" ADD CONSTRAINT "project_cluster_org_id_nn" CHECK ("project_cluster"."org_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "project_container_registries" ADD CONSTRAINT "project_container_registries_org_id_nn" CHECK ("project_container_registries"."org_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "project_databases" ADD CONSTRAINT "project_databases_org_id_nn" CHECK ("project_databases"."org_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "project_dns" ADD CONSTRAINT "project_dns_org_id_nn" CHECK ("project_dns"."org_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "project_git_credentials" ADD CONSTRAINT "project_git_credentials_org_id_nn" CHECK ("project_git_credentials"."org_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "project_helm_registries" ADD CONSTRAINT "project_helm_registries_org_id_nn" CHECK ("project_helm_registries"."org_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "project_iac_sources" ADD CONSTRAINT "project_iac_sources_org_id_nn" CHECK ("project_iac_sources"."org_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "project_network" ADD CONSTRAINT "project_network_org_id_nn" CHECK ("project_network"."org_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "project_nosql_tables" ADD CONSTRAINT "project_nosql_tables_org_id_nn" CHECK ("project_nosql_tables"."org_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "project_observability" ADD CONSTRAINT "project_observability_org_id_nn" CHECK ("project_observability"."org_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "project_queues" ADD CONSTRAINT "project_queues_org_id_nn" CHECK ("project_queues"."org_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_org_id_nn" CHECK ("project_repositories"."org_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "project_secrets" ADD CONSTRAINT "project_secrets_org_id_nn" CHECK ("project_secrets"."org_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "project_services" ADD CONSTRAINT "project_services_org_id_nn" CHECK ("project_services"."org_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "project_source_repos" ADD CONSTRAINT "project_source_repos_org_id_nn" CHECK ("project_source_repos"."org_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "project_storage_buckets" ADD CONSTRAINT "project_storage_buckets_org_id_nn" CHECK ("project_storage_buckets"."org_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "project_topics" ADD CONSTRAINT "project_topics_org_id_nn" CHECK ("project_topics"."org_id" IS NOT NULL);
