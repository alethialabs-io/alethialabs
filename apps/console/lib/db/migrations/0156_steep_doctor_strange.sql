-- 0156 (#5266): `project_cluster.capacity_type`, and a one-time pin of what already-provisioned
-- clusters run, so the same PR's template-default changes reshape none of them.
--
-- The two generated statements (the enum and the column) are kept verbatim and first; the data steps
-- that need the column follow them — per 0141's, 0150's and 0153's convention. The generated
-- snapshot (meta/0156_snapshot.json) describes the end state, which is what this file arrives at.
-- The whole file runs in ONE transaction, so a failure anywhere leaves nothing half-pinned.

-- ── Generated ──
CREATE TYPE "public"."node_capacity_type" AS ENUM('on_demand', 'spot');--> statement-breakpoint
ALTER TABLE "project_cluster" ADD COLUMN "capacity_type" "node_capacity_type";--> statement-breakpoint

-- ── #5266 data: BEGIN — pin what already-provisioned clusters run ──
--
-- The integration test (tests/integration/pin-provisioned-node-defaults.test.ts) executes the text
-- between this marker and the END marker, twice, against seeded rows: the shipped SQL is what it
-- tests, and the second run proves it is idempotent. Edit the markers and you break the test, loudly.
--
-- WHAT IS PINNED. Two template defaults change in the same PR, and both would reshape a running
-- cluster that relied on them on its next apply:
--   · the node machine type of a cluster that pins none: aws m5a.4xlarge → t3.large, gcp
--     e2-standard-4 → e2-standard-2, azure Standard_D4s_v5 → Standard_D2s_v5 (alibaba ecs.g6.large
--     and hetzner cpx22 did not change, so they are left alone);
--   · the aws node group's capacity type: SPOT → ON_DEMAND.
-- A provisioned cluster gets the OLD value written explicitly, so it keeps what it runs and the card
-- says so. Only clusters provisioned AFTER this migration take the catalog defaults.
--
-- "PROVISIONED", FROM EVIDENCE. A `dedicated` environment (the only placement that owns a cluster)
-- with at least one SUCCESS DEPLOY job, whose status is not DRAFT or DESTROYED — a destroyed
-- environment has no cluster left to reshape, and its next deploy is a new cluster.
--
-- WHICH ROW. The one resolveServingCluster (lib/queries/cluster-for-env.ts) returns: the row keyed
-- on the environment's Fabric first, then the env-keyed row. An environment with NEITHER deployed
-- with an empty snapshot cluster block; it gets a row here, carrying the pin, so the snapshot stops
-- being empty. Its counts and version are left to the column defaults (2/5/2, NULL), which are the
-- same values buildConfigSnapshot substituted for the missing row.
--
-- THE PROVIDER is derived the way the snapshot derives it: the row's own cloud_identity_id, else the
-- project's, through cloud_identities.provider.
--
-- "PINS NOTHING" means no instance type (NULL or empty) AND no node_size — a size resolves to a
-- machine type of its own and never reached the template default.

CREATE TEMP TABLE "_pin_legacy_node" ("provider" text PRIMARY KEY, "instance_type" text NOT NULL);--> statement-breakpoint
INSERT INTO "_pin_legacy_node" VALUES
	('aws', 'm5a.4xlarge'),
	('gcp', 'e2-standard-4'),
	('azure', 'Standard_D4s_v5');--> statement-breakpoint

-- A capacity type someone already chose by hand, through the generic provider_config passthrough
-- (`eks_ng_capacity_type` on aws), moves onto the typed column — which now owns that variable: the aws
-- provider reserves the key, so left in provider_config it would silently stop applying. Only a value
-- the template accepted (SPOT / ON_DEMAND) moves, and only on aws — the one cloud whose template
-- declares the variable; elsewhere the key never applied and a moved `spot` would now be refused.
UPDATE "project_cluster" c
SET
	"capacity_type" = CASE upper(c."provider_config"->>'eks_ng_capacity_type')
		WHEN 'SPOT' THEN 'spot'::"node_capacity_type"
		WHEN 'ON_DEMAND' THEN 'on_demand'::"node_capacity_type"
		ELSE c."capacity_type"
	END,
	"provider_config" = c."provider_config" - 'eks_ng_capacity_type'
FROM "projects" p, "cloud_identities" ci
WHERE p."id" = c."project_id"
  AND ci."id" = COALESCE(c."cloud_identity_id", p."cloud_identity_id")
  AND ci."provider" = 'aws'
  AND c."provider_config" ? 'eks_ng_capacity_type'
  AND c."capacity_type" IS NULL;--> statement-breakpoint

CREATE TEMP TABLE "_pin_provisioned" AS
SELECT
	e."id" AS "environment_id",
	e."project_id",
	e."fabric_id",
	e."status" AS "env_status",
	p."org_id",
	p."cloud_identity_id" AS "project_identity",
	COALESCE(
		(SELECT c."id" FROM "project_cluster" c
		  WHERE c."project_id" = e."project_id" AND e."fabric_id" IS NOT NULL AND c."fabric_id" = e."fabric_id"
		  ORDER BY c."created_at" LIMIT 1),
		(SELECT c."id" FROM "project_cluster" c
		  WHERE c."project_id" = e."project_id" AND c."environment_id" = e."id"
		  ORDER BY c."created_at" LIMIT 1)
	) AS "cluster_id"
FROM "project_environments" e
JOIN "projects" p ON p."id" = e."project_id"
WHERE e."placement_mode" = 'dedicated'
  AND e."status" NOT IN ('DRAFT', 'DESTROYED')
  AND EXISTS (
	SELECT 1 FROM "jobs" j
	 WHERE j."environment_id" = e."id" AND j."job_type" = 'DEPLOY' AND j."status" = 'SUCCESS'
  );--> statement-breakpoint

-- Existing rows: pin the old machine type where none is pinned, and SPOT on aws where no capacity
-- type is. Each SET arm is guarded by its own condition, so a row that already states one of the two
-- keeps it, and a second run changes nothing.
UPDATE "project_cluster" c
SET
	"instance_types" = CASE
		WHEN (c."instance_types" IS NULL OR cardinality(c."instance_types") = 0) AND c."node_size" IS NULL
			AND legacy."instance_type" IS NOT NULL
		THEN ARRAY[legacy."instance_type"]
		ELSE c."instance_types"
	END,
	"capacity_type" = CASE
		WHEN ci."provider" = 'aws' AND c."capacity_type" IS NULL THEN 'spot'::"node_capacity_type"
		ELSE c."capacity_type"
	END
FROM "_pin_provisioned" pv
JOIN "projects" p ON p."id" = pv."project_id"
JOIN "cloud_identities" ci ON TRUE
LEFT JOIN "_pin_legacy_node" legacy ON legacy."provider" = ci."provider"::text
WHERE c."id" = pv."cluster_id"
  AND ci."id" = COALESCE(c."cloud_identity_id", p."cloud_identity_id")
  AND (
	((c."instance_types" IS NULL OR cardinality(c."instance_types") = 0) AND c."node_size" IS NULL AND legacy."instance_type" IS NOT NULL)
	OR (ci."provider" = 'aws' AND c."capacity_type" IS NULL)
  );--> statement-breakpoint

-- Environments that deployed with NO cluster row: create it, carrying the pin. Only where there is
-- something to pin (a cloud whose default changed); alibaba and hetzner keep running on a default
-- that did not move, and a row would only restate it.
INSERT INTO "project_cluster" ("project_id", "org_id", "environment_id", "fabric_id", "instance_types", "capacity_type", "status")
SELECT
	pv."project_id",
	pv."org_id",
	pv."environment_id",
	pv."fabric_id",
	ARRAY[legacy."instance_type"],
	CASE WHEN ci."provider" = 'aws' THEN 'spot'::"node_capacity_type" END,
	CASE WHEN pv."env_status" = 'ACTIVE' THEN 'ACTIVE'::"component_status" ELSE 'PENDING'::"component_status" END
FROM "_pin_provisioned" pv
JOIN "cloud_identities" ci ON ci."id" = pv."project_identity"
JOIN "_pin_legacy_node" legacy ON legacy."provider" = ci."provider"::text
WHERE pv."cluster_id" IS NULL;--> statement-breakpoint

DROP TABLE "_pin_provisioned";--> statement-breakpoint
DROP TABLE "_pin_legacy_node";
-- ── #5266 data: END ──
