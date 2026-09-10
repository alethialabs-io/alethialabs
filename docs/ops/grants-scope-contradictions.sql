-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The #4583 audit: grants that carry a `resource_id` alongside a `resource_type` that CANNOT be
-- scoped to one. Two classes, and #4584 changes what BOTH of them mean.
--
-- READ-ONLY. Run in the service role against PRODUCTION and against any long-lived environment;
-- a dev database will not answer the question that matters. Classify; do NOT mutate. The runner
-- `pnpm -C apps/console run audit:grant-scopes` executes THIS file verbatim, so what a maintainer
-- runs in psql and what the tool runs cannot drift apart.
--
-- ══ ⚠ NEVER REMEDIATE ONE OF THESE BY REVOKING IT. NOT BEFORE THE #4584 FIX, NOT AFTER. ═══════
--
-- The row disappears and the OpenFGA tuples it created DO NOT. That is true on both sides of the
-- fix, for the same net result and two different reasons, and an earlier draft of this file said
-- "on a deployment that has not yet taken the #4584 fix", which told you the opposite:
--
--   BEFORE: `grantObject` built `org:<resource-uuid>` — an object type/id pair that does not
--           exist — while `expandGrant` had written the tuples on `org:<org-uuid>`. The delete
--           looked in the wrong place and found nothing.
--   AFTER:  the row expands to no tuples, so `removeScopedGrant` has no object to read and
--           deletes nothing AT ALL. Deliberately: the tuples it wrote under the old reading sit
--           on `org:<org-uuid>`, where they are indistinguishable from the tuples of a legitimate
--           org-wide grant conferring the same permission on the same subject. Deleting them
--           blind would revoke real access.
--
-- And `backfill` only ever WRITES — it never deletes — so nothing reconciles them away at boot
-- either. Evidence gone, privilege kept, on either side of the fix.
--
-- SAFE REMEDIATION, in preference order:
--   1. Write the corrected tuples explicitly (or delete the specific stale ones) against the
--      OpenFGA store, having first read this row's `also_org_wide` count to know whether the
--      same subject holds the permission by another route.
--   2. Rebuild the store from scratch: empty it, then `backfill()`. Reconciles everything,
--      costs a full re-expansion.
--   3. Only once the tuples are dealt with, decide what to do with the row itself.
-- ═════════════════════════════════════════════════════════════════════════════════════════════
--
-- ## The two classes, and what each means on each engine
--
-- `grants.resource_id NULL = org-wide (wildcard)` is the column's own contract
-- (`apps/console/lib/db/schema/authz.ts`), and `resource_type` is free `text`. A row carrying an
-- id alongside a kind that has no per-instance object is therefore self-contradictory. There are
-- two ways to write one, and they are NOT the same finding:
--
-- A. `pair_class = 'org-kind'` — `resource_type = 'org'` with an id. #4581 now refuses this at
--    both write boundaries, so it can only be a legacy row.
--
--      before #4584:  Postgres = scoped to that id (NARROW) · OpenFGA = ORGANIZATION-WIDE
--      after  #4584:  both = confers nothing
--
--    For an `allow` row the enterprise tier OVER-GRANTS today; the fix takes that away and also
--    takes away the narrow access the community tier grants today.
--
-- B. `pair_class = 'unscopable-kind'` — any other kind with no per-instance object: `job`,
--    `member`, `activity`, `billing`, `alert`, `fleet`, `support_case`, or a plain typo. THIS
--    CLASS IS STILL WRITEABLE. `app/api/cli/grants/route.ts` validates `resource_type` as
--    `z.string().min(1)` and refuses only the org pair, so one of these plus an id is a WORKING
--    SCOPED GRANT on the community PDP right now.
--
--      before #4584:  Postgres = scoped to that id (real access) · OpenFGA = no tuples at all
--      after  #4584:  both = confers nothing
--
--    So this class is a real access REMOVAL on the community tier, which is why it belongs in the
--    audit that gates the fix and not in a footnote. An earlier version of this query selected
--    only class A; an empty result then closed #4583 while saying nothing about class B.
--
-- Which engine an installation runs is an instance-wide environment switch, not a per-org setting.
--
-- ⚠ The scopable list in the `bad` CTE below is the four keys of `PARENTS` in
-- `apps/console/lib/authz/fga-hierarchy.ts`, which is what the running code derives its union
-- from. It is spelled out here because this file must be runnable in a bare psql session. It is
-- NOT trusted to stay in step by hand: `tests/integration/audit-grant-scopes.test.ts` reads this
-- list out of this file and asserts it equals `INSTANCE_TYPES`.
--
-- ## What each column answers
--
-- `pair_class`      — A or B above.
-- `resource_kind`   — what the id names in one of the five tables this query looks in
--                     (projects, runners, cloud_identities, connectors, organization).
--                     `not-found` means none of those five has it — it may still name a row in a
--                     table this query does not know about, so read it as "not found here", not
--                     as "nothing". `org` means the id names an organization, which is the "meant
--                     org-wide, typed it twice" shape rather than "meant scoped, forgot the kind".
-- `permissions`     — how many permission keys the row confers (its own key, or its role's bundle).
-- `also_org_wide`   — how many of those the SAME subject ALREADY holds at the SAME effect through
--                     a genuinely org-wide grant (`resource_id IS NULL`) in the same org. A
--                     team-held org-wide grant counts for a user principal when that user is in
--                     the team, because that is access the user really has.
-- `verdict`         — the two counts read together: whether remediating takes real access away.
--
-- `also_org_wide` compares at the SAME effect on purpose: for an `allow` row the question is
-- "is this permission already conferred org-wide anyway", and for a `deny` row it is "is this
-- already denied org-wide anyway". Comparing across effects would answer neither.
--
-- ⚠ It counts ORG-WIDE grants only. A *scoped* grant that happens to cover the same resource is
-- not counted, so `LIVE` is an over-report in the safe direction — it can say "no org-wide grant
-- confers these" about a subject who reaches the same resource through a properly scoped grant.
-- The verdict string says `org-wide` for that reason; do not read it as "nothing else confers it".
--
-- ## What each verdict means for remediation
--
-- REDUNDANT     — every permission is already held org-wide by another route. Dropping the id (or
--                 deleting the row) changes nobody's effective access on either engine.
-- PARTIAL       — some are. The uncovered ones are the ones a decision has to be made about.
-- LIVE          — none are. Remediation may be an access change, and needs the grantor's intent:
--                 re-scope to the id's real kind (`resource_kind` names it where it can), or drop
--                 the id and accept the grant as genuinely org-wide.
-- NO PERMISSION — the row references neither a role nor a permission key, so it confers nothing on
--                 either engine. A data defect, not an access one.
--
-- An EMPTY result closes #4583 for BOTH classes: the divergences in #4584 are then theoretical
-- rather than live, on this database.

WITH bad AS (
	SELECT
		g.id,
		g.org_id,
		g.principal_type,
		g.principal_id,
		g.effect,
		g.role_id,
		g.permission_key,
		g.resource_type,
		g.resource_id,
		g.created_at,
		CASE WHEN g.resource_type = 'org' THEN 'org-kind' ELSE 'unscopable-kind' END AS pair_class
	FROM grants g
	WHERE g.resource_id IS NOT NULL
	  -- The keys of PARENTS in apps/console/lib/authz/fga-hierarchy.ts. Pinned by
	  -- tests/integration/audit-grant-scopes.test.ts, which reads this literal back out.
	  AND g.resource_type NOT IN ('project', 'runner', 'cloud_identity', 'connector')
),
-- The permission keys a bad row actually confers. `grants` references EXACTLY one of
-- role_id / permission_key, so these two branches are disjoint by the table's own contract.
bad_perm AS (
	SELECT b.id AS grant_id, b.permission_key
	FROM bad b
	WHERE b.permission_key IS NOT NULL
	UNION ALL
	SELECT b.id AS grant_id, rp.permission_key
	FROM bad b
	JOIN role_permission rp ON rp.role_id = b.role_id
	WHERE b.role_id IS NOT NULL
),
-- Every GENUINELY org-wide grant in the table, flattened to one row per conferred permission key.
-- The LEFT JOIN + coalesce covers both shapes at once: a direct permission grant keeps its own key
-- (rp is null), a role grant fans out to the bundle.
org_wide_perm AS (
	SELECT
		o.org_id,
		o.effect,
		o.principal_type,
		o.principal_id,
		coalesce(o.permission_key, rp.permission_key) AS permission_key
	FROM grants o
	LEFT JOIN role_permission rp ON rp.role_id = o.role_id
	WHERE o.resource_id IS NULL
),
counted AS (
	SELECT
		b.id,
		b.pair_class,
		b.org_id,
		org.name AS org_name,
		b.principal_type,
		b.principal_id,
		coalesce(u.email, t.name) AS subject,
		b.effect,
		r.name AS role_name,
		b.permission_key,
		b.resource_type,
		b.resource_id,
		b.created_at,
		CASE
			WHEN EXISTS (SELECT 1 FROM projects p WHERE p.id = b.resource_id) THEN 'project'
			WHEN EXISTS (SELECT 1 FROM runners rn WHERE rn.id = b.resource_id) THEN 'runner'
			WHEN EXISTS (SELECT 1 FROM cloud_identities ci WHERE ci.id = b.resource_id) THEN 'cloud_identity'
			WHEN EXISTS (SELECT 1 FROM connectors c WHERE c.id = b.resource_id) THEN 'connector'
			WHEN EXISTS (SELECT 1 FROM organization o2 WHERE o2.id = b.resource_id) THEN 'org'
			ELSE 'not-found'
		END AS resource_kind,
		(SELECT count(*)::int FROM bad_perm bp WHERE bp.grant_id = b.id) AS permissions,
		(
			SELECT count(*)::int
			FROM bad_perm bp
			WHERE bp.grant_id = b.id
			  AND EXISTS (
				SELECT 1
				FROM org_wide_perm op
				WHERE op.org_id = b.org_id
				  AND op.effect = b.effect
				  AND op.permission_key = bp.permission_key
				  AND (
					(op.principal_type = b.principal_type AND op.principal_id = b.principal_id)
					-- A team's org-wide grant reaches a user principal through membership.
					OR (
						b.principal_type = 'user'
						AND op.principal_type = 'team'
						AND EXISTS (
							SELECT 1 FROM team_member tm
							WHERE tm.team_id = op.principal_id
							  AND tm.user_id = b.principal_id
						)
					)
				  )
			  )
		) AS also_org_wide
	FROM bad b
	LEFT JOIN organization org ON org.id = b.org_id
	LEFT JOIN "user" u ON b.principal_type = 'user' AND u.id = b.principal_id
	LEFT JOIN team t ON b.principal_type = 'team' AND t.id = b.principal_id
	LEFT JOIN role r ON r.id = b.role_id
)
SELECT
	c.id,
	c.pair_class,
	c.created_at,
	c.org_id,
	c.org_name,
	c.principal_type,
	c.principal_id,
	c.subject,
	c.effect,
	c.role_name,
	c.permission_key,
	c.resource_type,
	c.resource_id,
	c.resource_kind,
	c.permissions,
	c.also_org_wide,
	CASE
		WHEN c.permissions = 0 THEN 'NO PERMISSION — references neither a role nor a permission key'
		WHEN c.also_org_wide = c.permissions THEN 'REDUNDANT — already held org-wide; remediation removes no access'
		WHEN c.also_org_wide = 0 THEN 'LIVE — no ORG-WIDE grant confers these; remediation may be an access change'
		ELSE 'PARTIAL — some already held org-wide; the rest need a decision'
	END AS verdict
FROM counted c
ORDER BY c.pair_class, c.created_at;
