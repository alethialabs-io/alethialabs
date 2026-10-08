CREATE TABLE "elench_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"conversation_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"discarded_at" timestamp with time zone,
	"text" text NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"artifacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cell_target" jsonb,
	"claim_token" uuid,
	"claim_turn_id" uuid,
	"claim_kind" text,
	"claimed_at" timestamp with time zone,
	"failed_send" jsonb,
	"last_sent" jsonb,
	"thread_seen" boolean DEFAULT false NOT NULL,
	"title" text,
	"last_writer" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_elench_drafts_key" UNIQUE("user_id","org_id","conversation_id"),
	CONSTRAINT "elench_drafts_status" CHECK ("elench_drafts"."status" IN ('active', 'sending', 'discarded')),
	CONSTRAINT "elench_drafts_discarded_at" CHECK (("elench_drafts"."status" = 'discarded') = ("elench_drafts"."discarded_at" IS NOT NULL)),
	CONSTRAINT "elench_drafts_claim" CHECK (("elench_drafts"."status" = 'sending') = ("elench_drafts"."claim_token" IS NOT NULL AND "elench_drafts"."claim_turn_id" IS NOT NULL AND "elench_drafts"."claim_kind" IS NOT NULL AND "elench_drafts"."claimed_at" IS NOT NULL)),
	CONSTRAINT "elench_drafts_claim_kind" CHECK ("elench_drafts"."claim_kind" IS NULL OR "elench_drafts"."claim_kind" IN ('first', 'later')),
	CONSTRAINT "elench_drafts_text_size" CHECK (octet_length("elench_drafts"."text") <= 300000)
);
--> statement-breakpoint
CREATE INDEX "idx_elench_drafts_list" ON "elench_drafts" USING btree ("user_id","org_id","project_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_elench_drafts_updated" ON "elench_drafts" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_elench_drafts_discarded" ON "elench_drafts" USING btree ("discarded_at");--> statement-breakpoint
CREATE INDEX "idx_elench_drafts_claimed" ON "elench_drafts" USING btree ("claimed_at") WHERE status = 'sending';