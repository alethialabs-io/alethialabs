CREATE TABLE "cluster_admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"username" text NOT NULL,
	"groups" text[] DEFAULT '{}'::text[] NOT NULL,
	"ordinal" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cluster_admins" ADD CONSTRAINT "cluster_admins_cluster_id_project_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."project_cluster"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cluster_admins_cluster_id_idx" ON "cluster_admins" USING btree ("cluster_id");--> statement-breakpoint
-- Backfill: migrate existing project_cluster.cluster_admins JSONB into normalized rows, preserving
-- author order via `ordinal`. The nested `groups` JSON array becomes a text[]; a missing/absent
-- groups key defaults to an empty array. Only rows with a non-empty username are migrated.
INSERT INTO "cluster_admins" ("cluster_id", "username", "groups", "ordinal")
SELECT c."id",
       e.elem->>'username',
       COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(e.elem->'groups', '[]'::jsonb))), '{}'::text[]),
       (e.ord - 1)::int
FROM "project_cluster" c
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c."cluster_admins", '[]'::jsonb)) WITH ORDINALITY AS e(elem, ord)
WHERE COALESCE(e.elem->>'username', '') <> '';