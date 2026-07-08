ALTER TABLE "agent_threads" ADD COLUMN "project_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_agent_threads_project" ON "agent_threads" USING btree ("project_id");