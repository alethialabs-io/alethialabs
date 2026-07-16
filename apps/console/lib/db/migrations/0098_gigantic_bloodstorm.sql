CREATE TABLE "agent_message_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"message_id" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_message_feedback" ADD CONSTRAINT "agent_message_feedback_thread_id_agent_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."agent_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_message_feedback" ON "agent_message_feedback" USING btree ("thread_id","message_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_agent_message_feedback_thread" ON "agent_message_feedback" USING btree ("thread_id");