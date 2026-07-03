-- Richer cloud-connection lifecycle on cloud_identities: a status
-- (pending → testing → connected/failed), the last verification error, and when it
-- was last tested. Drives the connectors-page health treatment and the server-side
-- CONNECTION_TEST finalize (closes the client-verify race). `connected` ⇔
-- is_verified=true (both set together). Custom migration (db:generate is blocked by
-- a pre-existing snapshot-history fork — see 0034), matching the hand-authored style.
CREATE TYPE "public"."cloud_identity_status" AS ENUM('pending', 'testing', 'connected', 'failed');--> statement-breakpoint
ALTER TABLE "cloud_identities" ADD COLUMN IF NOT EXISTS "status" "cloud_identity_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_identities" ADD COLUMN IF NOT EXISTS "last_error" text;--> statement-breakpoint
ALTER TABLE "cloud_identities" ADD COLUMN IF NOT EXISTS "last_tested_at" timestamp with time zone;--> statement-breakpoint
-- Backfill existing verified accounts as connected (new rows default to pending).
UPDATE "cloud_identities" SET "status" = 'connected' WHERE "is_verified" = true AND "status" <> 'connected';
