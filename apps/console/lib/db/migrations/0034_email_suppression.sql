-- Email suppression list — addresses that hard-bounced or complained, written by the
-- SES SNS webhook (app/api/webhooks/ses) and checked before every send so we stop
-- mailing dead/complaining addresses. Global (no org_id), service-accessed. Custom
-- migration (db:generate is blocked by a pre-existing snapshot-history fork — see
-- 0030 / 0032 / 0033), matching the hand-authored style.
CREATE TYPE "public"."email_suppression_reason" AS ENUM('bounce', 'complaint');--> statement-breakpoint
CREATE TABLE "email_suppression" (
	"email" text PRIMARY KEY NOT NULL,
	"reason" "email_suppression_reason" NOT NULL,
	"source" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
