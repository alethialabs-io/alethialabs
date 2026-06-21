ALTER TABLE "alert_rules" ALTER COLUMN "event_patterns" SET DATA TYPE text[];--> statement-breakpoint
ALTER TABLE "alert_rules" ALTER COLUMN "event_patterns" SET DEFAULT '{}';