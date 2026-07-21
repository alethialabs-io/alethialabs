// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the fabric-scoped cluster model (activation seam #954). Proves against real Postgres:
// (1) resolveServingCluster resolves a `dedicated` env to its own 1:1 cluster; (2) a `namespace` env
// placed on the SAME Fabric — with NO cluster row of its own — resolves to that Fabric's shared
// cluster (the env→Fabric→cluster seam); (3) a legacy env whose fabric_id is NULL falls back to the
// env-keyed row (byte-identical for un-backfilled data); (4) the partial unique index
// `project_cluster_fabric_id_key` enforces at-most-one cluster per Fabric. Seeded via the service
// connection.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import {
	projectCluster,
	projectEnvironments,
	projectFabrics,
	projects,
} from "@/lib/db/schema";
import { resolveServingCluster } from "@/lib/queries/cluster-for-env";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const USER = randomUUID();
const PROJ = randomUUID();
const FABRIC = randomUUID();
const ENV_DEDICATED = randomUUID();
const ENV_NAMESPACE = randomUUID();
const ENV_LEGACY = randomUUID();
const CLUSTER_SHARED = randomUUID();
const CLUSTER_LEGACY = randomUUID();

describeIfDb("cluster-for-env — fabric-scoped resolution + shared-cluster invariant", () => {
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
		await db.insert(projectFabrics).values({
			id: FABRIC,
			project_id: PROJ,
			user_id: USER,
			org_id: ORG,
			name: "production",
		});
		await db.insert(projectEnvironments).values([
			// Dedicated env — owns the Fabric 1:1; carries the cluster row.
			{
				id: ENV_DEDICATED,
				project_id: PROJ,
				user_id: USER,
				name: "production",
				is_default: true,
				fabric_id: FABRIC,
				placement_mode: "dedicated",
			},
			// Namespace env — placed on the SAME Fabric; NO cluster row of its own.
			{
				id: ENV_NAMESPACE,
				project_id: PROJ,
				user_id: USER,
				name: "preview",
				fabric_id: FABRIC,
				placement_mode: "namespace",
				namespace: "preview",
			},
			// Legacy env — no Fabric link (un-backfilled); resolves by the env key.
			{
				id: ENV_LEGACY,
				project_id: PROJ,
				user_id: USER,
				name: "legacy",
				fabric_id: null,
				placement_mode: "dedicated",
			},
		]);
		// The Fabric's single (shared) cluster — owned by the dedicated env.
		await db.insert(projectCluster).values({
			id: CLUSTER_SHARED,
			project_id: PROJ,
			environment_id: ENV_DEDICATED,
			fabric_id: FABRIC,
			cluster_name: "shared-fabric-cluster",
		});
		// A legacy env-keyed cluster with no Fabric.
		await db.insert(projectCluster).values({
			id: CLUSTER_LEGACY,
			project_id: PROJ,
			environment_id: ENV_LEGACY,
			fabric_id: null,
			cluster_name: "legacy-cluster",
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(projects).where(eq(projects.id, PROJ)); // cascades to fabric/env/cluster
	});

	it("resolves a dedicated env to its own cluster", async () => {
		const cluster = await resolveServingCluster(getServiceDb(), PROJ, ENV_DEDICATED);
		expect(cluster?.id).toBe(CLUSTER_SHARED);
	});

	it("resolves a namespace env (no own cluster row) to the shared Fabric cluster", async () => {
		const cluster = await resolveServingCluster(getServiceDb(), PROJ, ENV_NAMESPACE);
		expect(cluster?.id).toBe(CLUSTER_SHARED);
		expect(cluster?.cluster_name).toBe("shared-fabric-cluster");
	});

	it("falls back to the env-keyed row for a legacy env with no fabric_id", async () => {
		const cluster = await resolveServingCluster(getServiceDb(), PROJ, ENV_LEGACY);
		expect(cluster?.id).toBe(CLUSTER_LEGACY);
	});

	it("enforces at-most-one cluster per Fabric (partial unique index)", async () => {
		const db = getServiceDb();
		await expect(
			db.insert(projectCluster).values({
				project_id: PROJ,
				environment_id: ENV_NAMESPACE,
				fabric_id: FABRIC, // second cluster on the same Fabric — must be rejected
				cluster_name: "second-cluster",
			}),
		).rejects.toThrow();
	});
});
