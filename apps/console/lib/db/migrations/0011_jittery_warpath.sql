CREATE TYPE "public"."credential_scope" AS ENUM('personal', 'org');--> statement-breakpoint
ALTER TABLE "connector_credentials" DROP CONSTRAINT "connector_credentials_user_connector_key";--> statement-breakpoint
ALTER TABLE "cloud_identities" ADD COLUMN "scope" "credential_scope" DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_credentials" ADD COLUMN "scope" "credential_scope" DEFAULT 'personal' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_credentials_personal_key" ON "connector_credentials" USING btree ("user_id","connector_id") WHERE scope = 'personal';--> statement-breakpoint
CREATE UNIQUE INDEX "connector_credentials_org_key" ON "connector_credentials" USING btree ("org_id","connector_id") WHERE scope = 'org';