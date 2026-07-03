CREATE TABLE "agent_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"title" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_agent_threads_user" ON "agent_threads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_agent_threads_org" ON "agent_threads" USING btree ("org_id");