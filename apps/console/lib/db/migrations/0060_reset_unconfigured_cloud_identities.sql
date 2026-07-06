-- Data-only cleanup (no schema change): reset cloud identities that were auto-created as
-- connect-sheet placeholders (initIdentity pre-creates one pending row per provider, with empty
-- credentials, just so the connect sheet has an id to bind to) but were then poisoned to a
-- non-pending status by the background connection sweep probing their empty credentials.
--
-- These surface a phantom "Verification failed → Re-verify" on the connectors page for a provider
-- the user never attempted to connect. The sweep no longer probes `pending` rows and the connectors
-- query ignores never-configured rows, so this one-time reset only needs to un-poison the existing
-- prod rows. It is idempotent and only ever touches rows that were never configured (empty creds).
UPDATE cloud_identities
SET status = 'pending',
    last_error = NULL,
    last_tested_at = NULL,
    updated_at = now()
WHERE is_verified = false
  AND status <> 'pending'
  AND COALESCE(credentials ->> 'role_arn', '') = ''
  AND COALESCE(credentials ->> 'token', '') = ''
  AND COALESCE(credentials ->> 'self_managed', '') = ''
  AND COALESCE(credentials ->> 'project_id', '') = ''
  AND COALESCE(credentials ->> 'service_account_email', '') = ''
  AND COALESCE(credentials ->> 'subscription_id', '') = ''
  AND COALESCE(credentials ->> 'tenant_id', '') = '';
