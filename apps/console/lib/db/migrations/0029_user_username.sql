-- Capture the OAuth provider handle (GitHub/GitLab/Bitbucket username) on signup;
-- seeds the auto-created organization slug. Null for providers without one (Google).
-- Custom migration (db:generate is blocked by a pre-existing snapshot-history fork,
-- itself blocked by the in-flight billing "business"-tier refactor).
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "username" text;
