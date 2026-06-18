ALTER TABLE "zones" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "cloud_identities" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "specs" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "org_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_zones_org" ON "zones" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_identities_org" ON "cloud_identities" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_specs_org" ON "specs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_runners_org" ON "runners" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_jobs_org" ON "jobs" USING btree ("org_id");