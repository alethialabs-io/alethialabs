-- Revert fleet_pools.locations from the Hetzner-only enum back to text[]: the fleet substrate is
-- pluggable, so location codes are provider-specific free text (validated in app code), not a DB
-- enum. Drop the default first so the DATA TYPE change lands, re-set it, then drop the now-unused
-- enum type. enum[]->text[] is total (enum labels are valid text).
ALTER TABLE "fleet_pools" ALTER COLUMN "locations" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "fleet_pools" ALTER COLUMN "locations" SET DATA TYPE text[] USING "locations"::text[];--> statement-breakpoint
ALTER TABLE "fleet_pools" ALTER COLUMN "locations" SET DEFAULT '{"fsn1"}';--> statement-breakpoint
DROP TYPE "public"."hetzner_location";
