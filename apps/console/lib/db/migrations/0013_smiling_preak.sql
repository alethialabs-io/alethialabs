ALTER TABLE "alert_rules" ADD COLUMN "event_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD COLUMN "escalate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD COLUMN "recipient" text;--> statement-breakpoint
ALTER TABLE "alert_rules" DROP COLUMN "event_pattern";