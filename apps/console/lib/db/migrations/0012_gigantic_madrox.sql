DROP INDEX "idx_alert_rules_org_event";--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD COLUMN "event_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD COLUMN "event_pattern" text NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD COLUMN "throttle_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_alert_deliveries_dedupe" ON "alert_deliveries" USING btree ("dedupe_key","created_at");--> statement-breakpoint
CREATE INDEX "idx_alert_rules_org" ON "alert_rules" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "alert_deliveries" DROP COLUMN "event_type";--> statement-breakpoint
ALTER TABLE "alert_rules" DROP COLUMN "event_type";--> statement-breakpoint
DROP TYPE "public"."alert_event_type";