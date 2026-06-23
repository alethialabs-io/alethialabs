ALTER TABLE "zones" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "specs" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_org_id_slug_key" UNIQUE("org_id","slug");--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_zone_id_slug_key" UNIQUE("zone_id","slug");