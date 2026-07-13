DROP INDEX "idx_fleet_pools_provider";--> statement-breakpoint
ALTER TABLE "fleet_pools" ADD COLUMN "deleting" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_fleet_pools_provider" ON "fleet_pools" USING btree ("provider") WHERE deleting = false;