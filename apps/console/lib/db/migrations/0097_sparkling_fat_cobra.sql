ALTER TABLE "agent_context" ADD COLUMN "documents" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Backfill: the old single free-text `notes` blob becomes ONE named document, so upgrading to
-- the document-based knowledge base never loses what someone already pinned. `notes` is left in
-- place (deprecated, unread) so dropping it stays a separate, reversible step.
UPDATE "agent_context"
SET "documents" = jsonb_build_array(
    jsonb_build_object(
      'id', gen_random_uuid()::text,
      'title', 'Notes',
      'content', "notes",
      'updated_at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    )
  )
WHERE btrim("notes") <> '' AND "documents" = '[]'::jsonb;
