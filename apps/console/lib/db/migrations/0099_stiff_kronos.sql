CREATE TABLE "agent_artifact_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_artifact_share_target" UNIQUE NULLS NOT DISTINCT("artifact_id","scope_type","scope_id")
);
--> statement-breakpoint
ALTER TABLE "agent_artifact_shares" ADD CONSTRAINT "agent_artifact_shares_artifact_id_agent_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."agent_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_artifact_shares_org" ON "agent_artifact_shares" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_artifact_shares_artifact" ON "agent_artifact_shares" USING btree ("artifact_id");