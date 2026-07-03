-- Verification override (elench): an authorized, time-boxed waiver of specific
-- failing verification controls, attached to a DEPLOY job so the runner can pass it
-- to the fail-closed gate (packages/core/verify Override). Nullable — NULL means no
-- waiver (the default; any hard control failure blocks apply). Shape:
--   { "controls": ["KEYLESS-001"], "reason": "...", "by": "<actor>", "expiry": "<RFC3339>" }
-- Custom migration (db:generate blocked by unrelated pending enum drift in the working
-- tree — same pattern as 0041/0042). Idempotent so a later drizzle-generated migration is safe.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "verify_override" jsonb;
