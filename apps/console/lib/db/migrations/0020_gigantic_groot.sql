CREATE TABLE "ai_credit_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"user_id" uuid NOT NULL,
	"credits" integer NOT NULL,
	"stripe_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_credit_grant_stripe_ref_unique" UNIQUE("stripe_ref")
);
--> statement-breakpoint
DROP INDEX "idx_ai_usage_org_kind_created";--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD COLUMN "credits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD COLUMN "source" text DEFAULT 'included' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_ai_credit_grant_org" ON "ai_credit_grant" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_ai_usage_org_source_created" ON "ai_usage_ledger" USING btree ("org_id","source","created_at");