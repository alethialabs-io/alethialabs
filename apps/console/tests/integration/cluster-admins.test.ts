// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the normalized cluster_admins child table + its contract-phase readers, now that the
// project_cluster.cluster_admins JSONB column is dropped. Proves against real Postgres: (1)
// clusterAdminsByCluster reconstructs a cluster's admins in author `ordinal` order with groups as
// text[] — the byte-stability guarantee buildConfigSnapshot / getProjectAsFormData rely on; (2) the
// project_full view re-exposes the same {username, groups} array from the child table (an ordered
// jsonb_agg subquery) so the CLI config endpoints are unchanged — guarded to run only once the
// contract migration has dropped the column (so it validates in CI's fresh DB, not the stale shared
// dev DB); (3) the join-through RLS policy scopes an admin to its cluster's project's org; (4) ON
// DELETE CASCADE removes a cluster's admins when the cluster is cleared. Seeded via the service
// connection; read back through the RLS-enforced app connection.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb, withScope } from "@/lib/db";
import { clusterAdminsByCluster } from "@/lib/db/normalized-reads";
import {
	clusterAdmins,
	projectCluster,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import type { ClusterAdmin } from "@/types/jsonb.types";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const USER = randomUUID();
const ORG_OTHER = randomUUID();
const USER_OTHER = randomUUID();
const PROJ = randomUUID();
const ENV = randomUUID();
const ENV2 = randomUUID(); // second env — project_cluster is UNIQUE per (project_id, environment_id)
const CLUSTER = randomUUID();

const APP_ROLE_DISTINCT =
	(process.env.ALETHIA_APP_DATABASE_URL ?? "") !== "" &&
	process.env.ALETHIA_APP_DATABASE_URL !== process.env.ALETHIA_DATABASE_URL;

describeIfDb("cluster_admins — reader parity, view, RLS, cascade", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await db.insert(projects).values({
			id: PROJ,
			org_id: ORG,
			user_id: USER,
			project_name: `p-${PROJ}`,
			region: "westeurope",
			iac_version: "1.0",
		});
		await db.insert(projectEnvironments).values([
			{ id: ENV, project_id: PROJ, user_id: USER, name: "production", is_default: true },
			{ id: ENV2, project_id: PROJ, user_id: USER, name: "staging", is_default: false },
		]);
		await db.insert(projectCluster).values({
			id: CLUSTER,
			project_id: PROJ,
			environment_id: ENV,
		});
		// Two admins; the second has multiple groups, and the author order must survive round-trips.
		await db.insert(clusterAdmins).values([
			{ cluster_id: CLUSTER, username: "alice", groups: ["platform"], ordinal: 0 },
			{ cluster_id: CLUSTER, username: "bob", groups: ["sre", "oncall"], ordinal: 1 },
		]);
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(projects).where(eq(projects.id, PROJ)); // cascades to env/cluster/admins
	});

	it("the reader reconstructs the admins in ordinal order, byte-identically", async () => {
		const db = getServiceDb();
		const admins = await clusterAdminsByCluster(db, CLUSTER);
		expect(admins).toEqual([
			{ username: "alice", groups: ["platform"] },
			{ username: "bob", groups: ["sre", "oncall"] },
		]);
	});

	it("a cluster with no admins reads back as []", async () => {
		const db = getServiceDb();
		// A cluster with zero admin rows (here, a nonexistent id) reconstructs as an empty array.
		expect(await clusterAdminsByCluster(db, randomUUID())).toEqual([]);
	});

	it("project_full re-exposes cluster_admins from the child table (post-migration)", async () => {
		const db = getServiceDb();
		// Only meaningful once the contract migration has dropped the column and programmables.sql
		// re-sourced the view from the child table. On a pre-migration DB (shared dev), the old view
		// still reads the column — skip to avoid a false red; CI runs it against a fresh migrated DB.
		const droppedRows = await db.execute<{ dropped: boolean }>(sql`
			SELECT NOT EXISTS(
				SELECT 1 FROM information_schema.columns
				WHERE table_name = 'project_cluster' AND column_name = 'cluster_admins'
			) AS dropped`);
		if (!droppedRows[0]?.dropped) return;
		const rows = await db.execute<{ cluster_admins: ClusterAdmin[] }>(
			sql`SELECT cluster_admins FROM project_full WHERE id = ${PROJ}`,
		);
		expect(rows[0]?.cluster_admins).toEqual([
			{ username: "alice", groups: ["platform"] },
			{ username: "bob", groups: ["sre", "oncall"] },
		]);
	});

	it("RLS scopes admins to the owning org (join-through the cluster)", async () => {
		if (!APP_ROLE_DISTINCT) return;
		const mine = await withScope({ ownerId: USER, orgId: ORG }, (tx) =>
			tx.select().from(clusterAdmins).where(eq(clusterAdmins.cluster_id, CLUSTER)),
		);
		expect(mine.length).toBeGreaterThan(0);
		const theirs = await withScope({ ownerId: USER_OTHER, orgId: ORG_OTHER }, (tx) =>
			tx.select().from(clusterAdmins).where(eq(clusterAdmins.cluster_id, CLUSTER)),
		);
		expect(theirs).toHaveLength(0);
	});

	it("ON DELETE CASCADE removes admins when the cluster is cleared", async () => {
		const db = getServiceDb();
		// project_cluster is UNIQUE on (project_id, environment_id), so the throwaway cluster lives in
		// its own environment (ENV2).
		const throwaway = randomUUID();
		await db.insert(projectCluster).values({
			id: throwaway,
			project_id: PROJ,
			environment_id: ENV2,
		});
		await db.insert(clusterAdmins).values({
			cluster_id: throwaway,
			username: "temp",
			groups: [],
			ordinal: 0,
		});
		await db.delete(projectCluster).where(eq(projectCluster.id, throwaway));
		const orphans = await db
			.select()
			.from(clusterAdmins)
			.where(eq(clusterAdmins.cluster_id, throwaway));
		expect(orphans).toHaveLength(0);
	});
});
