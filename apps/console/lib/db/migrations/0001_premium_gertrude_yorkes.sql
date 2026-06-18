ALTER TABLE "jobs" DROP CONSTRAINT "jobs_zone_id_zones_id_fk";
--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "zone_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE set null ON UPDATE no action;