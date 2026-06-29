-- Final lexicon cleanup: the per-project provisioning-status enum was physically named
-- "spec_status" (from the pre-rename era). Rename the type to "project_status" so no "spec"
-- remains in the schema. Renaming a Postgres enum type is metadata-only — the
-- project_environments.status column keeps working unchanged. Hand-authored (db:generate
-- needs a TTY) — matches the snapshot-less style of 0024–0037.
ALTER TYPE "public"."spec_status" RENAME TO "project_status";
