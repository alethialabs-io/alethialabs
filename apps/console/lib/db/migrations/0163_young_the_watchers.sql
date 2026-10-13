CREATE TABLE "agent_turn_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"turn_id" text NOT NULL,
	"attempt_key" text NOT NULL,
	"state" text NOT NULL,
	"token" uuid NOT NULL,
	"attempt_no" integer DEFAULT 1 NOT NULL,
	"billing_org_id" uuid NOT NULL,
	"project_id" uuid,
	"hold_id" uuid,
	"accepted_revision" integer NOT NULL,
	"answer_id" text,
	"partial" boolean DEFAULT false NOT NULL,
	"error" text,
	"lease_until" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "uq_agent_turn_claims_key" UNIQUE("thread_id","turn_id","attempt_key"),
	CONSTRAINT "agent_turn_claims_answered_has_answer" CHECK (("agent_turn_claims"."state" = 'answered') = ("agent_turn_claims"."answer_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "agent_threads" ADD COLUMN "billing_org_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_threads" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_turn_claims_one_running" ON "agent_turn_claims" USING btree ("thread_id") WHERE state = 'running';--> statement-breakpoint
CREATE INDEX "idx_agent_turn_claims_lease" ON "agent_turn_claims" USING btree ("lease_until") WHERE state = 'running';--> statement-breakpoint
CREATE INDEX "idx_agent_turn_claims_hold" ON "agent_turn_claims" USING btree ("hold_id") WHERE state = 'running';--> statement-breakpoint
CREATE INDEX "idx_agent_turn_claims_finished" ON "agent_turn_claims" USING btree ("finished_at") WHERE state <> 'running';