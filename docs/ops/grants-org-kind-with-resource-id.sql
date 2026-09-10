-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The #4583 audit: grants that name the `org` resource kind while carrying a resource id.
--
-- READ-ONLY. Run in the service role against PRODUCTION and against any long-lived environment;
-- a dev database will not answer the question that matters. Classify; do NOT mutate. The runner
-- `pnpm -C apps/console run audit:org-scope-grants` executes THIS file verbatim, so what a
-- maintainer runs in psql and what the tool runs cannot drift apart.
--
-- ⚠ DO NOT REMEDIATE BY REVOKING, on a deployment that has not yet taken the #4584 fix.
-- `ee/src/fga-tuple-sync.ts`'s revoke path looked for tuples on `org:<resource-uuid>` — an object
-- that does not exist — while the tuples were written on `org:<org-uuid>`. A revoke there removes
-- the ROW and leaves the ACCESS, i.e. it destroys the evidence and keeps the privilege.
--
-- ## What the pair means today, and why the answer differs per engine
--
-- `grants.resource_id NULL = org-wide (wildcard)` is the column's own contract
-- (`apps/console/lib/db/schema/authz.ts`). A row carrying BOTH `resource_type = 'org'` and a
-- non-null `resource_id` is therefore self-contradictory, and the two shipped PDPs resolve the
-- contradiction in opposite directions:
--
--   * `PostgresRbacPDP` (community) never read `resource_type` at all — any non-null `resource_id`
--     is scoped to that id. The row is NARROW.
--   * `expandGrant` → OpenFGA (enterprise) took `resource_type = 'org'` as org-wide and dropped the
--     id before building a tuple. The row is ORGANIZATION-WIDE.
--
-- So for an `allow` row the enterprise tier OVER-GRANTS; for a `deny` row it over-denies. Which
-- engine an installation runs is an instance-wide environment switch, not a per-org setting.
--
-- ## What each column answers
--
-- `resource_kind`   — what the id actually names TODAY. `GONE` means nothing does: the row is
--                     inert under the Postgres reading and org-wide under the OpenFGA one, which
--                     is the widest possible gap between the two engines on one row. `org` means
--                     the id names an organization, which is the "meant org-wide, typed it twice"
--                     shape rather than the "meant scoped, forgot the kind" shape.
-- `permissions`     — how many permission keys the row confers (its own key, or its role's bundle).
-- `also_org_wide`   — how many of those the SAME subject ALREADY holds at the SAME effect through a
--                     genuinely org-wide grant (`resource_id IS NULL`) in the same org. A team-held
--                     org-wide grant counts for a user principal when that user is in the team,
--                     because that is access the user really has.
-- `verdict`         — the two counts read together. This is the column that decides whether
--                     remediating the row takes real access away from a real person.
--
-- `also_org_wide` compares at the SAME effect on purpose: for an `allow` row the question is
-- "is this permission already conferred org-wide anyway", and for a `deny` row it is "is this
-- already denied org-wide anyway". Comparing across effects would answer neither.
--
-- ## What each verdict means for remediation
--
-- REDUNDANT     — every permission is already held org-wide by another route. Dropping the id (or
--                 deleting the row) changes nobody's effective access on either engine.
-- PARTIAL       — some are. The uncovered ones are the ones a decision has to be made about.
-- LIVE          — none are. Whatever this row confers today, it is the only thing conferring it,
--                 so remediation IS an access change and needs the grantor's intent: re-scope to
--                 the id's real kind (`resource_kind` names it), or drop the id and accept the
--                 grant as genuinely org-wide.
-- NO PERMISSION — the row references neither a role nor a permission key, so it confers nothing on
--                 either engine. A data defect, not an access one.
--
-- An EMPTY result closes #4583: the divergences in #4584 are then theoretical rather than live.

WITH bad AS (
	SELECT
		g.id,
		g.org_id,
		g.principal_type,
		g.principal_id,
		g.effect,
		g.role_id,
		g.permission_key,
		g.resource_id,
		g.created_at
	FROM grants g
	WHERE g.resource_type = 'org'
	  AND g.resource_id IS NOT NULL
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
		b.org_id,
		org.name AS org_name,
		b.principal_type,
		b.principal_id,
		coalesce(u.email, t.name) AS subject,
		b.effect,
		r.name AS role_name,
		b.permission_key,
		b.resource_id,
		b.created_at,
		CASE
			WHEN EXISTS (SELECT 1 FROM projects p WHERE p.id = b.resource_id) THEN 'project'
			WHEN EXISTS (SELECT 1 FROM runners rn WHERE rn.id = b.resource_id) THEN 'runner'
			WHEN EXISTS (SELECT 1 FROM cloud_identities ci WHERE ci.id = b.resource_id) THEN 'cloud_identity'
			WHEN EXISTS (SELECT 1 FROM connectors c WHERE c.id = b.resource_id) THEN 'connector'
			WHEN EXISTS (SELECT 1 FROM organization o2 WHERE o2.id = b.resource_id) THEN 'org'
			ELSE 'GONE'
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
	c.created_at,
	c.org_id,
	c.org_name,
	c.principal_type,
	c.principal_id,
	c.subject,
	c.effect,
	c.role_name,
	c.permission_key,
	c.resource_id,
	c.resource_kind,
	c.permissions,
	c.also_org_wide,
	CASE
		WHEN c.permissions = 0 THEN 'NO PERMISSION — references neither a role nor a permission key'
		WHEN c.also_org_wide = c.permissions THEN 'REDUNDANT — already held org-wide; remediation removes no access'
		WHEN c.also_org_wide = 0 THEN 'LIVE — nothing else confers these; remediation IS an access change'
		ELSE 'PARTIAL — some already held org-wide; the rest need a decision'
	END AS verdict
FROM counted c
ORDER BY c.created_at;
