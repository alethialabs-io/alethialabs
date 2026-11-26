DROP INDEX "idx_authz_activity_org_id_desc";--> statement-breakpoint
CREATE INDEX "idx_authz_activity_org_ts_ms_id" ON "authz_activity_log" USING btree ("org_id",date_trunc('milliseconds', ("ts" at time zone 'UTC')) desc,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "idx_authz_activity_org_id_desc" ON "authz_activity_log" USING btree ("org_id","id" DESC NULLS FIRST);