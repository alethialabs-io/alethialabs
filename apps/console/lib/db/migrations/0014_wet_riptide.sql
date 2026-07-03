-- event_patterns was introduced as jsonb in 0013 and reshaped to native text[] in the
-- same release; no row has been written yet, so drop + re-add (no USING-cast needed).
ALTER TABLE "alert_rules" DROP COLUMN "event_patterns";--> statement-breakpoint
ALTER TABLE "alert_rules" ADD COLUMN "event_patterns" text[] DEFAULT '{}' NOT NULL;
