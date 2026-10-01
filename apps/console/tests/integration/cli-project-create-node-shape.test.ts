// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: `alethia project create --instance-type / --node-size` (#5266) against real Postgres.
// POST /api/cli/projects runs the shared create core and then `insertCreateTimeClusters` in ONE
// transaction. What a mock cannot show: that the row lands on each `dedicated` environment with its
// Fabric linkage, that a `namespace` environment gets none (it resolves the shared cluster by
// Fabric), that a create with no dedicated environment rolls the whole project back, and that the
// two shapes are written as what they are — a machine type as `instance_types`, a size as
// `node_size` with no default type stamped beside it.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import {
	type CreateClusterShape,
	insertCreateTimeClusters,
	NoDedicatedEnvironmentError,
} from "@/lib/cli/create-cluster-shape";
import { getServiceDb } from "@/lib/db";
import {
	projectCluster,
	projectEnvironments,
	projectFabrics,
	projects,
	resourceHierarchy,
} from "@/lib/db/schema";
import type { PlacementMode } from "@/lib/db/schema/enums";
import { type EnvironmentSpec, insertProjectWithDefaultFabric } from "@/lib/queries/projects";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const USER = randomUUID();

/** Creates a project the way the route does — the core plus the shape, in one transaction. */
async function createWithShape(
	shape: CreateClusterShape,
	opts: { environments?: EnvironmentSpec[]; placement_mode?: PlacementMode } = {},
) {
	const db = getServiceDb();
	return db.transaction(async (tx) => {
		const created = await insertProjectWithDefaultFabric(tx, {
			project_name: `p-${randomUUID()}`,
			region: "eu-west-1",
			iac_version: "1.11.4",
			environment_stage: "production",
			environments: opts.environments,
			placement_mode: opts.placement_mode,
			owner: USER,
			orgId: ORG,
		});
		const written = await insertCreateTimeClusters(tx, created.project.id, shape);
		return { projectId: created.project.id, written };
	});
}

/** The project's cluster rows, joined to the placement of the environment that owns each. */
async function clustersOf(projectId: string) {
	const db = getServiceDb();
	return db
		.select({
			environment_id: projectCluster.environment_id,
			fabric_id: projectCluster.fabric_id,
			instance_types: projectCluster.instance_types,
			node_size: projectCluster.node_size,
			placement_mode: projectEnvironments.placement_mode,
			env_fabric_id: projectEnvironments.fabric_id,
		})
		.from(projectCluster)
		.innerJoin(projectEnvironments, eq(projectEnvironments.id, projectCluster.environment_id))
		.where(eq(projectCluster.project_id, projectId));
}

describeIfDb("CLI project create — the node shape becomes a cluster row (#5266)", () => {
	afterAll(async () => {
		const db = getServiceDb();
		const rows = await db.select({ id: projects.id }).from(projects).where(eq(projects.org_id, ORG));
		const ids = rows.map((r) => r.id);
		if (ids.length === 0) return;
		await db.delete(projectCluster).where(inArray(projectCluster.project_id, ids));
		await db.delete(projectEnvironments).where(inArray(projectEnvironments.project_id, ids));
		await db.delete(projectFabrics).where(inArray(projectFabrics.project_id, ids));
		await db
			.delete(resourceHierarchy)
			.where(and(eq(resourceHierarchy.child_type, "project"), inArray(resourceHierarchy.child_id, ids)));
		await db.delete(projects).where(eq(projects.org_id, ORG));
	});

	it("writes the machine type on the dedicated environment only, with its Fabric", async () => {
		const { projectId, written } = await createWithShape({ instance_type: "t3.xlarge" });
		expect(written).toBe(1);
		const rows = await clustersOf(projectId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.placement_mode).toBe("dedicated");
		expect(rows[0]?.instance_types).toEqual(["t3.xlarge"]);
		expect(rows[0]?.node_size).toBeNull();
		expect(rows[0]?.fabric_id).toBe(rows[0]?.env_fabric_id);
	});

	it("writes a size as node_size, with NO default machine type beside it", async () => {
		const { projectId } = await createWithShape({ node_size: { vcpu: 4, memory_gb: 16 } });
		const rows = await clustersOf(projectId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.node_size).toEqual({ vcpu: 4, memory_gb: 16 });
		// A stamped type would win over the size in the Go resolver and discard it.
		expect(rows[0]?.instance_types).toBeNull();
	});

	it("gives every dedicated environment of a matrix its own row, and namespace ones none", async () => {
		const { projectId, written } = await createWithShape(
			{ instance_type: "t3.xlarge" },
			{
				environments: [
					{ name: "prod", stage: "production", placement_mode: "dedicated", is_default: true },
					{ name: "staging", stage: "staging", placement_mode: "dedicated" },
					{ name: "dev", stage: "development", placement_mode: "namespace", namespace: "dev" },
				],
			},
		);
		expect(written).toBe(2);
		const rows = await clustersOf(projectId);
		expect(rows.map((r) => r.placement_mode)).toEqual(["dedicated", "dedicated"]);
	});

	it("refuses a shape no environment can carry, and rolls the project back", async () => {
		const db = getServiceDb();
		const before = await db.select({ id: projects.id }).from(projects).where(eq(projects.org_id, ORG));
		await expect(
			// The legacy pair with the default env moved off `dedicated`: vcluster + namespace, so no
			// environment provisions a cluster.
			createWithShape({ instance_type: "t3.xlarge" }, { placement_mode: "vcluster" }),
		).rejects.toBeInstanceOf(NoDedicatedEnvironmentError);
		const after = await db.select({ id: projects.id }).from(projects).where(eq(projects.org_id, ORG));
		expect(after).toHaveLength(before.length);
	});
});
