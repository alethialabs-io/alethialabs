DROP INDEX "idx_runners_one_default_per_user";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_runners_one_default_per_user_org" ON "runners" USING btree ("user_id","org_id") WHERE is_default = true;