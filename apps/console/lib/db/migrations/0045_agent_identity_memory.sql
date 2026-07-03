-- Agent identity + memory (elench): a scoped, persistent agent modeled as DATA
-- (persona/mission/tool-scope/memory-namespace) plus a per-tenant memory store keyed
-- by (namespace, path). The stateless executor reconstructs context per call. Path
-- traversal is guarded in app code (lib/agent/memory-path.ts) so one tenant can never
-- read another's memory.
-- Custom migration (db:generate blocked by unrelated pending enum drift in the working
-- tree — same pattern as 0041/0042/0043). Idempotent.
CREATE TABLE IF NOT EXISTS "agent_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "org_id" uuid,
  "project_id" uuid,
  "persona" text NOT NULL,
  "mission" text NOT NULL,
  "tool_scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "memory_namespace" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_identities_user" ON "agent_identities" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_identities_org" ON "agent_identities" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_identities_project" ON "agent_identities" ("project_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_memory" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "namespace" text NOT NULL,
  "path" text NOT NULL,
  "content" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_agent_memory_ns_path" ON "agent_memory" ("namespace","path");
