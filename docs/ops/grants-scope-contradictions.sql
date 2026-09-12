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
--    CLASS IS STILL WRITEABLE. `apps/console/app/api/cli/grants/route.ts` validates `resource_type` as
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
-- NOT trusted to stay in step by hand: `apps/console/tests/integration/audit-grant-scopes.test.ts`
-- reads this list out of this file and asserts it equals `INSTANCE_TYPES`.
--
-- ══ ⚠ THIS QUERY IS ALSO THE PRE-DEPLOY CHECK, AND THE TWO QUESTIONS ARE DIFFERENT ═══════════
--
-- `also_org_wide` / `verdict` answer the REMEDIATION question: "if I clean this row up, does the
-- subject lose access they hold nowhere else?" That is the right question for an ALLOW row.
--
-- `deploy_change` answers a second, independent one: "when #4584 SHIPS, does this row start
-- meaning something wider or narrower than it does now?" Nobody edits anything for that to
-- happen — `backfill` re-expands every raw grant on every boot, so the deploy itself is what
-- changes what these rows mean. A clean remediation verdict says nothing about it.
--
-- The direction differs by EFFECT, and that is the part it is easy to miss:
--
--   allow → NARROWS. The row confers nothing afterwards. `also_org_wide` says whether that
--     removes real access.
--   deny  → WIDENS. The exclusion goes from one resource to the whole org.
--     `also_allowed_anywhere` says whether there is anything for the wider exclusion to bite.
--
-- ⚠ AND THE WIDENING REACHES A CLASS THE RULING WAS NOT DECIDED ON. The maintainer ruled that a
-- deny with an uninterpretable scope excludes org-wide, on the argument that this is what OpenFGA
-- ALREADY does for the pair and what every deployed store's surviving tuples already say — so no
-- deployed store's deny behaviour changes. **That argument is true of `pair_class = 'org-kind'`
-- and FALSE of `unscopable-kind`**: for the latter OpenFGA produced no tuples at all, so the
-- exclusion goes from NOTHING to the whole org there, and from one resource to the whole org on
-- Postgres. Both directions remove access, on rows nobody touched.
--
-- ⚠ THERE IS NO OPTION THAT PRESERVES THIS CLASS'S CURRENT BEHAVIOUR. Keeping the per-id
-- exclusion Postgres does today is not expressible in OpenFGA: the model has object types for
-- `org`, `project`, `runner`, `cloud_identity`, `connector`, `team` and `user` and for nothing
-- else, so there is no `job:` or `member:` object to hang a deny tuple on. The two expressible
-- readings are therefore:
--
--   org-wide (the ruling)  — fail-CLOSED. Widens the exclusion. REMOVES access on deploy.
--   nothing (drop the row) — fail-OPEN. The exclusion disappears; a subject denied a permission
--                            on one resource has it back. Both engines agree on this reading, so
--                            it is NOT divergent — but it is the same fail-open direction the
--                            maintainer rejected for the org-kind pair.
--
-- (Measured, not reasoned: making `denyTarget` widen for the org kind ONLY was run against both
-- real engines, and the `ENGINE DIVERGENCE` assertion fired ZERO times — the engines agree under
-- either reading. An earlier version of this note claimed scoping the ruling would re-open the
-- divergence. It would not, and that claim was wrong.)
--
-- So the uniform ruling is the one consistent with "an ambiguous exclusion is not a licence", and
-- what it costs is a live behaviour change that has to be MEASURED before deploy rather than
-- assumed — which is what `deploy_change` is for. Rows in this class are STILL WRITEABLE; see
-- class B below.
-- ═════════════════════════════════════════════════════════════════════════════════════════════
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
--                     the team, because that is access the user really has. THE REMEDIATION
--                     question.
-- `also_allowed_anywhere`
--                   — how many of those the same subject holds through an ALLOW grant at ANY
--                     scope in the org. THE DEPLOY question, for a deny row: nothing to bite
--                     means the widening changes nothing observable; a non-zero count means it
--                     removes access on first boot.
-- `scope_today_pg` / `scope_today_fga` / `scope_after`
--                   — what the row scopes to on each engine now, and what both will agree on
--                     after. `scope_today_fga` is where the two classes part company.
-- `deploy_change`   — those three read together: WIDENS or NARROWS, and on which engine(s).
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
--                 either engine, and nothing can change that without editing the row. A data
--                 defect, not an access one.
-- EMPTY ROLE    — it binds a role whose bundle is currently EMPTY, so it confers nothing TODAY and
--                 will confer whatever that role is later given. ⚠ NOT the same finding as the one
--                 above, and the difference flips the advice: `role` rows exist before their
--                 `role_permission` rows, and ee lets an org author a role and populate it later,
--                 so deleting this row on "it confers nothing" grounds removes a grant that was
--                 about to become live. `bad_perm`'s role arm is an inner JOIN, which is why both
--                 land on `permissions = 0`; `role_name` names the role either way.
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
	  -- apps/console/tests/integration/audit-grant-scopes.test.ts, which reads it back out.
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
-- Every ALLOW grant in the table, at ANY scope, flattened per permission key. This is the
-- DENY-side counterpart to `org_wide_perm`: for a deny row that is about to widen from one
-- resource to the whole org, it answers "is there anything for the wider exclusion to bite?"
-- A row that widens against a subject holding no allow of that permission changes nothing
-- observable; one that widens against an org-wide allow removes real access on first boot.
any_allow_perm AS (
	SELECT
		o.org_id,
		o.principal_type,
		o.principal_id,
		coalesce(o.permission_key, rp.permission_key) AS permission_key
	FROM grants o
	LEFT JOIN role_permission rp ON rp.role_id = o.role_id
	WHERE o.effect = 'allow'
),
counted AS (
	SELECT
		b.id,
		b.pair_class,
		b.role_id,
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
		) AS also_org_wide,
		(
			SELECT count(*)::int
			FROM bad_perm bp
			WHERE bp.grant_id = b.id
			  AND EXISTS (
				SELECT 1
				FROM any_allow_perm ap
				WHERE ap.org_id = b.org_id
				  AND ap.permission_key = bp.permission_key
				  AND (
					(ap.principal_type = b.principal_type AND ap.principal_id = b.principal_id)
					OR (
						b.principal_type = 'user'
						AND ap.principal_type = 'team'
						AND EXISTS (
							SELECT 1 FROM team_member tm
							WHERE tm.team_id = ap.principal_id
							  AND tm.user_id = b.principal_id
						)
					)
				  )
			  )
		) AS also_allowed_anywhere,
		-- What the row means TODAY, per engine, and what it will mean AFTER. Postgres never read
		-- `resource_type`, so every one of these rows is scoped to its id there, in both classes
		-- and both effects. OpenFGA differs BY CLASS: it took the `org` kind as org-wide and
		-- produced no tuples at all for an unscopable kind.
		'this-resource' AS scope_today_pg,
		CASE WHEN b.pair_class = 'org-kind' THEN 'org-wide' ELSE 'nothing' END AS scope_today_fga,
		CASE WHEN b.effect = 'deny' THEN 'org-wide' ELSE 'nothing' END AS scope_after
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
	c.also_allowed_anywhere,
	c.scope_today_pg,
	c.scope_today_fga,
	c.scope_after,
	CASE
		WHEN c.effect = 'deny' AND c.pair_class = 'unscopable-kind' THEN
			'WIDENS ON BOTH ENGINES — excludes the ORG after (today: this resource on Postgres, NOTHING on OpenFGA). Removes access on first boot.'
		WHEN c.effect = 'deny' THEN
			'WIDENS ON POSTGRES — excludes the ORG after (today: this resource). OpenFGA already excluded the org, so it does not move.'
		WHEN c.pair_class = 'unscopable-kind' THEN
			'NARROWS ON POSTGRES — confers nothing after (today: this resource). OpenFGA already conferred nothing.'
		ELSE
			'NARROWS ON BOTH ENGINES — confers nothing after (today: this resource on Postgres, THE ORG on OpenFGA).'
	END AS deploy_change,
	CASE
		WHEN c.permissions = 0 AND c.role_id IS NULL AND c.permission_key IS NULL
			THEN 'NO PERMISSION — references neither a role nor a permission key'
		WHEN c.permissions = 0
			THEN 'EMPTY ROLE — the role it binds confers nothing TODAY; add one permission and this row is live'
		WHEN c.also_org_wide = c.permissions THEN 'REDUNDANT — already held org-wide; remediation removes no access'
		WHEN c.also_org_wide = 0 THEN 'LIVE — no ORG-WIDE grant confers these; remediation may be an access change'
		ELSE 'PARTIAL — some already held org-wide; the rest need a decision'
	END AS verdict
FROM counted c
ORDER BY c.pair_class, c.created_at;
