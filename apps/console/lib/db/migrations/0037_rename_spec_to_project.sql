-- Rename the "spec" concept to "project" at the physical tier: tables (specs/spec_*),
-- the spec_id FK column everywhere, every constraint/index carrying the spec prefix, and
-- the authz registry data (permission keys, resource types, hierarchy edges). The Drizzle
-- schema, programmables.sql (project_full view + triggers + RLS) and all app code were
-- renamed in lockstep; this is the trailing physical migration. Hand-authored (db:generate
-- needs a TTY) — matches the snapshot-less style of 0024–0036.

-- 1. Drop the dependent read-model view first; programmables.sql recreates it as project_full.
DROP VIEW IF EXISTS public.spec_full;--> statement-breakpoint

-- 2. Rename the tables (specs + every spec_* component/grouping table).
ALTER TABLE public.specs RENAME TO projects;--> statement-breakpoint
ALTER TABLE public.spec_environments RENAME TO project_environments;--> statement-breakpoint
ALTER TABLE public.spec_network RENAME TO project_network;--> statement-breakpoint
ALTER TABLE public.spec_cluster RENAME TO project_cluster;--> statement-breakpoint
ALTER TABLE public.spec_dns RENAME TO project_dns;--> statement-breakpoint
ALTER TABLE public.spec_observability RENAME TO project_observability;--> statement-breakpoint
ALTER TABLE public.spec_repositories RENAME TO project_repositories;--> statement-breakpoint
ALTER TABLE public.spec_databases RENAME TO project_databases;--> statement-breakpoint
ALTER TABLE public.spec_caches RENAME TO project_caches;--> statement-breakpoint
ALTER TABLE public.spec_queues RENAME TO project_queues;--> statement-breakpoint
ALTER TABLE public.spec_topics RENAME TO project_topics;--> statement-breakpoint
ALTER TABLE public.spec_nosql_tables RENAME TO project_nosql_tables;--> statement-breakpoint
ALTER TABLE public.spec_container_registries RENAME TO project_container_registries;--> statement-breakpoint
ALTER TABLE public.spec_secrets RENAME TO project_secrets;--> statement-breakpoint
ALTER TABLE public.spec_storage_buckets RENAME TO project_storage_buckets;--> statement-breakpoint
ALTER TABLE public.spec_git_credentials RENAME TO project_git_credentials;--> statement-breakpoint

-- 3. Rename the spec_id FK column to project_id on every table that carries it
--    (projects itself is the root and has none).
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'project_environments', 'project_network', 'project_cluster', 'project_dns',
    'project_observability', 'project_repositories', 'project_databases', 'project_caches',
    'project_queues', 'project_topics', 'project_nosql_tables', 'project_container_registries',
    'project_secrets', 'project_storage_buckets', 'project_git_credentials',
    'audit_log', 'jobs'
  ]) LOOP
    EXECUTE format('ALTER TABLE public.%I RENAME COLUMN spec_id TO project_id', tbl);
  END LOOP;
END $$;--> statement-breakpoint

-- 4. Rename every constraint whose name carries the spec prefix (PKs, the singleton
--    spec_id uniques, the (spec_id, name) uniques, FKs to specs/spec_environments, the
--    git-credentials CHECK). replace() turns specs_org_id_slug_key → projects_org_id_slug_key,
--    spec_databases_spec_id_name_key → project_databases_project_id_name_key,
--    jobs_spec_id_specs_id_fk → jobs_project_id_projects_id_fk, etc. Renaming a UNIQUE/PK
--    constraint renames its backing index too.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT conrelid::regclass AS tbl, conname
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace AND conname LIKE '%spec%'
  LOOP
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
                   r.tbl, r.conname, replace(r.conname, 'spec', 'project'));
  END LOOP;
END $$;--> statement-breakpoint

-- 5. Rename the remaining standalone indexes (idx_specs_*, idx_spec_environments_spec,
--    idx_audit_log_spec, spec_environments_one_default). Constraint-backing indexes were
--    already renamed in step 4, so they no longer match here.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND indexname LIKE '%spec%'
  LOOP
    EXECUTE format('ALTER INDEX public.%I RENAME TO %I',
                   r.indexname, replace(r.indexname, 'spec', 'project'));
  END LOOP;
END $$;--> statement-breakpoint

-- 6. Authz registry data. permission.key is the PK referenced by role_permission and
--    grants with ON UPDATE NO ACTION, so drop those FKs, repoint the keys, then re-add.
ALTER TABLE public.role_permission DROP CONSTRAINT role_permission_permission_key_permission_key_fk;--> statement-breakpoint
ALTER TABLE public.grants DROP CONSTRAINT grants_permission_key_permission_key_fk;--> statement-breakpoint

UPDATE public.permission
   SET key = replace(key, 'spec:', 'project:'), resource = 'project'
 WHERE resource = 'spec';--> statement-breakpoint
UPDATE public.role_permission
   SET permission_key = replace(permission_key, 'spec:', 'project:')
 WHERE permission_key LIKE 'spec:%';--> statement-breakpoint
UPDATE public.grants
   SET permission_key = replace(permission_key, 'spec:', 'project:')
 WHERE permission_key LIKE 'spec:%';--> statement-breakpoint
UPDATE public.grants SET resource_type = 'project' WHERE resource_type = 'spec';--> statement-breakpoint
UPDATE public.resource_hierarchy SET child_type = 'project' WHERE child_type = 'spec';--> statement-breakpoint
UPDATE public.resource_hierarchy SET parent_type = 'project' WHERE parent_type = 'spec';--> statement-breakpoint
UPDATE public.authz_activity_log SET resource_type = 'project' WHERE resource_type = 'spec';--> statement-breakpoint

ALTER TABLE public.role_permission
  ADD CONSTRAINT role_permission_permission_key_permission_key_fk
  FOREIGN KEY (permission_key) REFERENCES public.permission(key) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE public.grants
  ADD CONSTRAINT grants_permission_key_permission_key_fk
  FOREIGN KEY (permission_key) REFERENCES public.permission(key) ON DELETE cascade ON UPDATE no action;
