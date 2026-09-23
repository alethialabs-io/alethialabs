-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
-- SPDX-License-Identifier: AGPL-3.0-only
--
-- At-risk rows for the ALETHIA_KEYLESS_DB_AUTH_ENABLED deletion (#1513).
--
-- READ-ONLY. Run in the service role, per environment, before the default-on decision. Classify;
-- do NOT mutate. Clearing `iam_auth` on an excluded cell would be exactly the defect #1510 removed
-- — silently turning off a security setting the user asked for — and the console gate at
-- app/server/actions/projects.ts already throws for those rows, so there is no unsafe render to
-- prevent. There is only a tenant to notify.
--
-- Why this is needed at all: with the flag OFF, an `iam_auth = true` row on a cell that cannot
-- honor keyless silently keeps the password path. Deleting the flag makes every such row render
-- keyless on its next deploy. `iam_auth` is user-settable from the canvas, the CLI and the AI
-- assistant, and the gates that now prevent a bad row were added LATER — so rows persisted before
-- them are the migration hazard.
--
-- ── Two joins matter, and one of them used to LOSE rows ──────────────────────────────────────
--
--   * project_databases.cloud_identity_id is NULLABLE and inherits projects.cloud_identity_id, so
--     the provider must be resolved with COALESCE. Joining it directly under-counts.
--
--   * That COALESCE can still be NULL, and the join to cloud_identities must therefore be a LEFT
--     join. BOTH columns are `uuid().references(cloudIdentities.id, { onDelete: "set null" })`
--     (apps/console/lib/db/schema/project-components.ts:91, .../projects.ts:30), so DELETING a
--     cloud identity nulls every reference to it. Under the INNER join this file used to carry,
--     such a row vanished from the audit entirely — and a keyless-marked database whose cloud
--     identity was deleted is precisely an at-risk row, not an irrelevant one. It is now reported
--     as UNRESOLVED rather than dropped.
--
-- The rule this encodes: an audit that silently excludes what it cannot classify reports a clean
-- result and a smaller number, which is the same shape of answer as "there is nothing wrong".
-- Every `iam_auth = true` row is accounted for in exactly one bucket below, and the reconciliation
-- query at the bottom is how you check that claim rather than trusting it.
--
-- The engine defaults to postgres when engine_family and engine are both null, which is the same
-- defaulting apps/console/lib/cloud-providers/keyless.ts:32-36 applies. A DEFAULTED engine is not
-- a declared one, so `engine_source` distinguishes them: a row classified on an inferred engine is
-- a weaker statement than one that declared it. (One deliberate divergence: the console matches
-- `engine.includes("mysql")` case-sensitively; this uses ILIKE, so a legacy 'MySQL' string is
-- caught here and would be read as postgres by the console. A row reported `inferred-*` with a
-- non-null engine string is worth reading by hand.)

WITH resolved AS (
	SELECT
		d.id,
		d.project_id,
		d.environment_id,
		d.name,
		ci.provider AS provider,
		CASE
			WHEN d.engine_family = 'mysql' THEN 'mysql'
			WHEN d.engine_family = 'postgres' THEN 'postgres'
			WHEN d.engine ILIKE '%mysql%' THEN 'mysql'
			ELSE 'postgres'
		END AS engine,
		CASE
			WHEN d.engine_family IN ('mysql', 'postgres') THEN 'declared'
			WHEN d.engine IS NOT NULL THEN 'inferred-from-legacy-engine'
			ELSE 'inferred-default-postgres'
		END AS engine_source,
		d.status,
		d.created_at,
		d.updated_at
	FROM project_databases d
	-- INNER by design: project_id is NOT NULL and ON DELETE CASCADE, so an orphan cannot exist.
	JOIN projects p ON p.id = d.project_id
	-- LEFT by necessity: see the header. A NULL provider is REPORTED, never dropped.
	LEFT JOIN cloud_identities ci
		ON ci.id = COALESCE(d.cloud_identity_id, p.cloud_identity_id)
	WHERE d.iam_auth IS TRUE
)
SELECT
	COALESCE(provider, '(unresolved)') AS provider,
	engine,
	engine_source,
	-- `row_count` rather than `rows` for readability only. `AS rows` parses fine — ROWS is a
	-- non-reserved keyword and an `AS` label accepts any keyword (checked on Postgres 15:
	-- `SELECT 1 AS rows` and even `SELECT 1 AS select` both run).
	count(*) AS row_count,
	count(*) FILTER (WHERE status = 'READY') AS live_rows,
	min(created_at) AS oldest,
	CASE
		-- Neither the database nor its project names a cloud identity that still exists. The
		-- deploy's behaviour cannot be predicted from this table alone, so this is the bucket
		-- that must be read by hand — it is NOT a synonym for "none".
		WHEN provider IS NULL
			THEN 'UNRESOLVED CLOUD — the identity was deleted or never set (ON DELETE SET NULL); classify by hand before deciding'
		-- Excluded cells. The console gate already throws for these, so they are currently
		-- UN-DEPLOYABLE — a support burden to surface, not a render to fix.
		WHEN provider IN ('alibaba', 'hetzner')
			THEN 'EXCLUDED CELL — deploy already refuses today; notify or leave to the honest error'
		-- Live cells. These render keyless the moment the flag goes, and on aws/azure that means the
		-- db-authproxy sidecar plus a bootstrap Job that has never run for this instance.
		WHEN provider IN ('aws', 'azure')
			THEN 'LIVE — first-ever bootstrap Job run on an instance that has been up for months'
		WHEN provider = 'gcp'
			THEN 'LIVE — native proxy, but the bootstrap Job is equally first-ever (guard precedes the provider switch)'
		ELSE 'UNKNOWN PROVIDER — refused by keylessUnavailableReasonForCloud; investigate'
	END AS classification
FROM resolved
GROUP BY provider, engine, engine_source
-- Positional, deliberately. `ORDER BY provider` would bind to the COALESCE'd OUTPUT column rather
-- than the CTE's nullable one (Postgres resolves ORDER BY to output aliases first), so a
-- `NULLS LAST` written there would silently never apply. Ordinals cannot be read two ways.
ORDER BY 1, 2, 3;

-- ── Reconciliation. Run this SECOND and check the two numbers agree. ─────────────────────────
--
-- `raw` counts the predicate with no joins at all; `grouped` counts it through the SAME joins the
-- `resolved` CTE uses. If they differ, a join dropped rows and the report above understates the
-- risk — the failure this query exists to make visible rather than to assume away.
--
-- What it does NOT check: it carries its own copy of the joins, so it proves THIS join shape keeps
-- every row, not that the report above still uses it. Close that gap by hand — the report's
-- `row_count` column must SUM to `raw_rows`. (Exercised against a fixture schema on Postgres 15:
-- a database whose own and project identity were both deleted lands in `(unresolved)`, and the
-- two counts agree; under the old INNER join that row was absent from the report.)
--
--   WITH raw AS (SELECT count(*) AS n FROM project_databases WHERE iam_auth IS TRUE),
--        grouped AS (
--          SELECT count(*) AS n
--          FROM project_databases d
--          JOIN projects p ON p.id = d.project_id
--          LEFT JOIN cloud_identities ci
--            ON ci.id = COALESCE(d.cloud_identity_id, p.cloud_identity_id)
--          WHERE d.iam_auth IS TRUE
--        )
--   SELECT raw.n AS raw_rows, grouped.n AS reported_rows,
--          raw.n - grouped.n AS dropped_rows,
--          CASE WHEN raw.n = grouped.n THEN 'OK — every row is accounted for'
--               ELSE 'DROPPED ROWS — the report above understates the risk' END AS verdict
--   FROM raw, grouped;
--
-- ── The per-row form is what a maintainer actually reads before deciding. Same CTE, no GROUP BY:
--
--   SELECT id, project_id, environment_id, name,
--          COALESCE(provider, '(unresolved)') AS provider, engine, engine_source, status, created_at
--   FROM resolved
--   ORDER BY 5, 6, 9;
