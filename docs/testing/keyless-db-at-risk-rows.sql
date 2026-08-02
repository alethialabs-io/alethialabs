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
-- Two joins matter:
--   * project_databases.cloud_identity_id is NULLABLE and inherits projects.cloud_identity_id, so
--     the provider must be resolved with COALESCE. Joining it directly under-counts.
--   * the engine defaults to postgres when engine_family and engine are both null, which is the
--     same defaulting apps/console/lib/cloud-providers/keyless.ts applies.

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
		d.status,
		d.created_at,
		d.updated_at
	FROM project_databases d
	JOIN projects p ON p.id = d.project_id
	JOIN cloud_identities ci
		ON ci.id = COALESCE(d.cloud_identity_id, p.cloud_identity_id)
	WHERE d.iam_auth IS TRUE
)
SELECT
	provider,
	engine,
	count(*) AS rows,
	count(*) FILTER (WHERE status = 'READY') AS live_rows,
	min(created_at) AS oldest,
	CASE
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
GROUP BY provider, engine
ORDER BY provider, engine;

-- The per-row form is what a maintainer actually reads before deciding. Same CTE, no GROUP BY:
--
--   SELECT id, project_id, environment_id, name, provider, engine, status, created_at
--   FROM resolved
--   ORDER BY provider, engine, created_at;
