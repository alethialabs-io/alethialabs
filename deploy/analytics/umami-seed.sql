-- SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Idempotent Umami seed, run by the `umami-init` one-shot after Umami is healthy. Lets the console
-- have a deterministic NEXT_PUBLIC_UMAMI_WEBSITE_ID on its FIRST deploy (no dashboard step, no redeploy)
-- and rotates the default admin password. psql variables are passed via -v: :wid (website uuid),
-- :pw (new admin password), :dom (website domain, may be empty).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Set the admin password to UMAMI_ADMIN_PASSWORD (the vault is the source of truth — don't change it in
-- the UI, or update the vault). pgcrypto writes a $2a$ bcrypt hash, which Umami's bcryptjs accepts.
-- (We can't "only rotate the default": Umami stores $2b$ hashes, which pgcrypto can't verify — but it
-- writes fine — so this always sets it, idempotently, to the stable vault value.)
UPDATE "user"
SET password = crypt(:'pw', gen_salt('bf', 10)), updated_at = now()
WHERE username = 'admin' AND :'pw' <> '';

-- Seed the console's website with our deterministic id (admin looked up dynamically). Idempotent.
-- Columns match Umami v2.x's `website` table (website_id, name, domain, user_id, created_by, timestamps).
-- NB: do NOT add `recorder_enabled` — that column does not exist in v2.16 (it 500'd the seed in prod);
-- Umami's own session recorder is unused here (replay = OpenReplay).
INSERT INTO website (website_id, name, domain, user_id, created_by, created_at, updated_at)
SELECT :'wid'::uuid, 'Alethia Console', NULLIF(:'dom', ''), u.user_id, u.user_id, now(), now()
FROM "user" u
WHERE u.username = 'admin'
ON CONFLICT (website_id) DO NOTHING;
