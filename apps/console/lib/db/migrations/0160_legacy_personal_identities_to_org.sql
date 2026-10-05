-- 0160 (#5481): a `personal` cloud identity that sits in a TEAM org goes back to `org` scope.
--
-- Data-only. The schema is unchanged, so meta/0160_snapshot.json describes the same schema as 0159's
-- (drizzle-kit `generate --custom` wrote it, chained after 0159).
--
-- WHY
--
-- Migration 0011 added `cloud_identities.scope` as `DEFAULT 'personal' NOT NULL`, so every row that
-- already existed became `personal`, whatever org it sat in. Until #5481 that label did not matter
-- on the service-db paths: the claim route and the identity checks in `POST /api/jobs` and
-- `POST /api/cli/projects` admitted any identity whose `org_id` was the job's or the caller's org.
-- #5481 tightened those to the `scoped_all` RLS policy: an identity of a team org is shared with
-- that org's other members only when it is `org` scope. Without this migration, every pre-0011
-- identity in a team org would stop reaching the jobs of members other than its author.
--
-- This restores the shared semantics those rows had before 0011. It also widens the RLS-scoped
-- reads: since 0011 the `scoped_all` policy has shown these rows to their author only, and after
-- this it shows them to every member of their org, as it does any `org` identity.
--
-- WHICH ROWS
--
-- `scope = 'personal' AND org_id <> user_id`. A user's personal org has the user's own id, so
-- `org_id = user_id` is a true personal identity and is left alone. A NULL `org_id` fails `<>` and
-- is left alone too. The console's one insert path for cloud identities (`initIdentity` in
-- lib/cloud-providers/connections.ts) writes `scope = 'org'`, so the code does not create the rows
-- this matches; they are the rows 0011 defaulted.
--
-- SAFETY
--
-- One UPDATE of one column (plus `updated_at`). No row is deleted, and no other column changes.
-- Idempotent: a converted row no longer matches, so a second run updates nothing. There is no
-- unique index on `cloud_identities.scope`, so the change cannot collide. RLS on this table is
-- ENABLEd, not FORCEd, so the migrating role (the table owner) sees every row.
--
-- The integration test (tests/integration/legacy-personal-identity-scope.test.ts) executes the
-- text between the BEGIN and END markers, twice, against seeded rows. Edit the markers and the test
-- fails.

-- ── #5481 data: BEGIN ──
UPDATE cloud_identities
SET scope      = 'org',
    updated_at = now()
WHERE scope = 'personal'
  AND org_id <> user_id;
-- ── #5481 data: END ──
