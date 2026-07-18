CREATE TABLE "topic_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"protocol" "topic_subscription_protocol" NOT NULL,
	"endpoint" text NOT NULL,
	"ordinal" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "topic_subscriptions" ADD CONSTRAINT "topic_subscriptions_topic_id_project_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."project_topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "topic_subscriptions_topic_id_idx" ON "topic_subscriptions" USING btree ("topic_id");--> statement-breakpoint
-- Backfill: migrate existing project_topics.subscriptions JSONB into normalized rows, preserving
-- author order via `ordinal`. Only rows with a non-empty endpoint AND a valid enum protocol are
-- migrated (the inspector only ever produced https/sqs/email/lambda; anything else is legacy noise
-- that would fail the enum cast — filtered, not silently coerced). One-time (runs with this migration).
INSERT INTO "topic_subscriptions" ("topic_id", "protocol", "endpoint", "ordinal")
SELECT t."id",
       (e.elem->>'protocol')::"topic_subscription_protocol",
       e.elem->>'endpoint',
       (e.ord - 1)::int
FROM "project_topics" t
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t."subscriptions", '[]'::jsonb)) WITH ORDINALITY AS e(elem, ord)
WHERE COALESCE(e.elem->>'endpoint', '') <> ''
  AND (e.elem->>'protocol') IN ('https', 'sqs', 'email', 'lambda');