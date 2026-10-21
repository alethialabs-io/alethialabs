ALTER TABLE "org_signing_key" DROP CONSTRAINT "org_signing_key_key_id_key";--> statement-breakpoint
CREATE UNIQUE INDEX "org_signing_key_org_key_id_key" ON "org_signing_key" USING btree ("org_id","key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_signing_key_verified_key_id_key" ON "org_signing_key" USING btree ("key_id") WHERE "org_signing_key"."status" = 'active';