DROP INDEX "idx_authz_activity_org";--> statement-breakpoint
CREATE INDEX "idx_authz_activity_org_id_desc" ON "authz_activity_log" USING btree ("org_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_authz_activity_ts" ON "authz_activity_log" USING btree ("ts");