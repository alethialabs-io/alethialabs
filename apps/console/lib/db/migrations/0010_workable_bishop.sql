CREATE TYPE "public"."alert_channel_type" AS ENUM('webhook', 'email', 'slack', 'rocketchat');--> statement-breakpoint
CREATE TYPE "public"."alert_delivery_status" AS ENUM('pending', 'sent', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."alert_event_type" AS ENUM('job_failed', 'job_succeeded', 'spec_destroyed', 'connector_token_expired', 'authz_denied', 'authz_sensitive_allow', 'grant_changed', 'role_changed');--> statement-breakpoint
CREATE TYPE "public"."alert_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TABLE "alert_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"type" "alert_channel_type" NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"last_verified_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"rule_id" uuid,
	"channel_id" uuid,
	"event_type" "alert_event_type" NOT NULL,
	"context" jsonb NOT NULL,
	"status" "alert_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "alert_rule_channels" (
	"rule_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	CONSTRAINT "alert_rule_channels_rule_id_channel_id_pk" PRIMARY KEY("rule_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"event_type" "alert_event_type" NOT NULL,
	"match" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"severity" "alert_severity" DEFAULT 'warning' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_rule_id_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_channel_id_alert_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."alert_channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rule_channels" ADD CONSTRAINT "alert_rule_channels_rule_id_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rule_channels" ADD CONSTRAINT "alert_rule_channels_channel_id_alert_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."alert_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_alert_channels_org" ON "alert_channels" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_alert_deliveries_sweep" ON "alert_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_alert_deliveries_org_created" ON "alert_deliveries" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_alert_rule_channels_channel" ON "alert_rule_channels" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_alert_rules_org_event" ON "alert_rules" USING btree ("org_id","event_type");