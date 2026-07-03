CREATE TYPE "public"."connector_health_kind" AS ENUM('git', 'api_key');--> statement-breakpoint
CREATE TYPE "public"."connector_health_status" AS ENUM('healthy', 'failed');--> statement-breakpoint
CREATE TABLE "connector_health" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "connector_health_kind" NOT NULL,
	"provider" text NOT NULL,
	"status" "connector_health_status" NOT NULL,
	"last_error" text,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"alerted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "connector_health_user_kind_provider" ON "connector_health" USING btree ("user_id","kind","provider");--> statement-breakpoint
CREATE INDEX "idx_connector_health_org" ON "connector_health" USING btree ("org_id");