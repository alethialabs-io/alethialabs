CREATE TABLE "thread_widgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"source" jsonb DEFAULT 'null'::jsonb,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pos_x" integer NOT NULL,
	"pos_y" integer NOT NULL,
	"colspan" integer DEFAULT 1 NOT NULL,
	"rowspan" integer DEFAULT 1 NOT NULL,
	"mode" text DEFAULT 'frozen' NOT NULL,
	"tool_call_id" text,
	"refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "thread_widgets" ADD CONSTRAINT "thread_widgets_thread_id_agent_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."agent_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_thread_widgets_thread" ON "thread_widgets" USING btree ("thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_thread_widgets_toolcall" ON "thread_widgets" USING btree ("thread_id","tool_call_id");