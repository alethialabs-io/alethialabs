CREATE TABLE "agent_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"spec" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "thread_widgets" ADD COLUMN "artifact_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_artifacts_org_name" ON "agent_artifacts" USING btree ("org_id","name");--> statement-breakpoint
ALTER TABLE "thread_widgets" ADD CONSTRAINT "thread_widgets_artifact_id_agent_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."agent_artifacts"("id") ON DELETE set null ON UPDATE no action;