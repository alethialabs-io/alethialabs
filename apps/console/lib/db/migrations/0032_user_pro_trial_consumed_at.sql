-- One-time, account-wide Pro trial ledger: when the account started its single Pro
-- trial (NULL = still available). Set by startProTrial; read by getProOffer so the
-- trial can be offered on /onboarding and the create-org sheet but only ever once.
-- Bound to the user (not the org) so spinning up extra orgs grants no extra trials.
-- Custom migration (db:generate is blocked by a pre-existing snapshot-history fork —
-- see 0029 / 0031).
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "pro_trial_consumed_at" timestamp with time zone;
