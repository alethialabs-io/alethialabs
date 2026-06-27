-- Rename the authorization decision log to the "Activity" name used everywhere in code
-- + UI: authz_audit_log → authz_activity_log (and its index). Data is preserved — this is
-- a pure rename. The owned identity sequence (authz_audit_log_id_seq) is never referenced
-- by name, so it's left as-is. Custom migration (db:generate is blocked by a pre-existing
-- snapshot-history fork — see 0030 / 0032), matching the hand-authored style.
ALTER TABLE IF EXISTS "authz_audit_log" RENAME TO "authz_activity_log";--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_authz_audit_org" RENAME TO "idx_authz_activity_org";
