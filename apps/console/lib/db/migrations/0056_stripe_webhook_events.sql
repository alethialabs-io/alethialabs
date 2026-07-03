CREATE TYPE "public"."stripe_webhook_event_status" AS ENUM('processing', 'done', 'error');--> statement-breakpoint
CREATE TABLE "stripe_webhook_event" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"status" "stripe_webhook_event_status" DEFAULT 'processing' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
