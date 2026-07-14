CREATE TABLE "agent_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"project_id" uuid,
	"instructions" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_agent_context_scope" UNIQUE NULLS NOT DISTINCT("org_id","project_id")
);
--> statement-breakpoint
CREATE INDEX "idx_agent_context_org" ON "agent_context" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_agent_context_project" ON "agent_context" USING btree ("project_id");