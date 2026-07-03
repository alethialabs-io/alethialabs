CREATE TABLE "ai_usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"kind" text NOT NULL,
	"ref_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_ai_usage_org_kind_created" ON "ai_usage_ledger" USING btree ("org_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "idx_ai_usage_user" ON "ai_usage_ledger" USING btree ("user_id");