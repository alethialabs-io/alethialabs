// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the normalized cluster_admins child table (Phase C.2). Proves against real Postgres:
// (1) the migration BACKFILL unnests project_cluster.cluster_admins JSONB into rows, turning the
// nested `groups` JSON array into a text[] and preserving author `ordinal`; (2) the join-through RLS
// policy scopes an admin to its cluster's project's org; (3) ON DELETE CASCADE removes a cluster's
// admins when the cluster is cleared. Seeded via the service connection; read back through the
// RLS-enforced app connection.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb, withScope } from "@/lib/db";
import {
	clusterAdmins,
	projectCluster,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const USER = randomUUID();
const ORG_OTHER = randomUUID();
const USER_OTHER = randomUUID();
const PROJ = randomUUID();
const ENV = randomUUID();
const CLUSTER = randomUUID();

const APP_ROLE_DISTINCT =
	(process.env.ALETHIA_APP_DATABASE_URL ?? "") !== "" &&
	process.env.ALETHIA_APP_DATABASE_URL !== process.env.ALETHIA_DATABASE_URL;

describeIfDb("cluster_admins — backfill, RLS, cascade", () => {
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
		await db.insert(projectEnvironments).values({
			id: ENV,
			project_id: PROJ,
			user_id: USER,
			name: "production",
			is_default: true,
		});
		// A cluster carrying the legacy JSONB — the backfill's input. Two admins; the second has
		// multiple groups, the ordering must survive.
		await db.insert(projectCluster).values({
			id: CLUSTER,
			project_id: PROJ,
			environment_id: ENV,
			cluster_admins: [
				{ username: "alice", groups: ["platform"] },
				{ username: "bob", groups: ["sre", "oncall"] },
			],
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(projects).where(eq(projects.id, PROJ)); // cascades to env/cluster/admins
	});

	it("backfill unnests the JSONB into ordered rows with groups as text[]", async () => {
		const db = getServiceDb();
		await db.execute(sql`
			INSERT INTO cluster_admins (cluster_id, username, groups, ordinal)
			SELECT c.id,
			       e.elem->>'username',
			       COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(e.elem->'groups', '[]'::jsonb))), '{}'::text[]),
			       (e.ord - 1)::int
			FROM project_cluster c
			CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.cluster_admins, '[]'::jsonb)) WITH ORDINALITY AS e(elem, ord)
			WHERE c.id = ${CLUSTER}
			  AND COALESCE(e.elem->>'username', '') <> ''
		`);
		const rows = await db
			.select()
			.from(clusterAdmins)
			.where(eq(clusterAdmins.cluster_id, CLUSTER))
			.orderBy(clusterAdmins.ordinal);
		expect(rows.map((r) => [r.ordinal, r.username, r.groups])).toEqual([
			[0, "alice", ["platform"]],
			[1, "bob", ["sre", "oncall"]],
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
		await db.insert(clusterAdmins).values({
			cluster_id: CLUSTER,
			username: "temp",
			groups: [],
			ordinal: 99,
		});
		await db.delete(projectCluster).where(eq(projectCluster.id, CLUSTER));
		const orphans = await db
			.select()
			.from(clusterAdmins)
			.where(eq(clusterAdmins.cluster_id, CLUSTER));
		expect(orphans).toHaveLength(0);
	});
});
