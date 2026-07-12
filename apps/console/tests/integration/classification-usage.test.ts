// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the classification usage-count queries (lib/queries/classification.ts) against
// real Postgres — per-value assignment counts, distinct-resources-per-dimension coverage (which
// must NOT double-count a multi-valued resource), and the per-resource-kind drill-down. Seeds a
// small taxonomy + assignments via the service connection (bypasses RLS); every id is unique so
// grouping/filtering by our ids isolates the assertions from other orgs' rows. Cleans up by id.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import {
	classificationAssignment,
	classificationDimension,
	classificationValue,
} from "@/lib/db/schema";
import {
	countAssignmentsByKindForValue,
	countAssignmentsByValue,
	countResourcesByDimension,
} from "@/lib/queries/classification";
import { describeIfDb } from "./db";

const ORG_ID = randomUUID();
const USER_ID = randomUUID();
const DIM_MULTI = randomUUID(); // multi axis (e.g. "Team")
const DIM_SINGLE = randomUUID(); // single axis (e.g. "Environment")
const V1 = randomUUID(); // on DIM_MULTI — 2 projects
const V2 = randomUUID(); // on DIM_MULTI — 1 project (same resource as a V1 pin)
const V3 = randomUUID(); // on DIM_SINGLE — 1 cluster + 1 runner
const V_UNUSED = randomUUID(); // on DIM_SINGLE — no assignments

// Concrete resources.
const R_PROJ_A = randomUUID();
const R_PROJ_B = randomUUID();
const R_CLUSTER = randomUUID();
const R_RUNNER = randomUUID();

describeIfDb("classification usage counts", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await db.insert(classificationDimension).values([
			{
				id: DIM_MULTI,
				org_id: ORG_ID,
				created_by: USER_ID,
				key: `team-${DIM_MULTI.slice(0, 6)}`,
				label: "Team",
				multi: true,
			},
			{
				id: DIM_SINGLE,
				org_id: ORG_ID,
				created_by: USER_ID,
				key: `env-${DIM_SINGLE.slice(0, 6)}`,
				label: "Environment",
				multi: false,
				applies_to: ["project_environment"],
			},
		]);
		await db.insert(classificationValue).values([
			{ id: V1, org_id: ORG_ID, dimension_id: DIM_MULTI, value: "core", label: "Core" },
			{ id: V2, org_id: ORG_ID, dimension_id: DIM_MULTI, value: "data", label: "Data" },
			{ id: V3, org_id: ORG_ID, dimension_id: DIM_SINGLE, value: "prod", label: "Prod" },
			{
				id: V_UNUSED,
				org_id: ORG_ID,
				dimension_id: DIM_SINGLE,
				value: "dev",
				label: "Dev",
			},
		]);
		await db.insert(classificationAssignment).values([
			// V1 on two projects; V2 also on project A → DIM_MULTI covers {A, B} = 2 distinct
			// resources, though the per-value counts sum to 3.
			{ org_id: ORG_ID, dimension_id: DIM_MULTI, value_id: V1, resource_kind: "project", resource_id: R_PROJ_A, assigned_by: USER_ID },
			{ org_id: ORG_ID, dimension_id: DIM_MULTI, value_id: V1, resource_kind: "project", resource_id: R_PROJ_B, assigned_by: USER_ID },
			{ org_id: ORG_ID, dimension_id: DIM_MULTI, value_id: V2, resource_kind: "project", resource_id: R_PROJ_A, assigned_by: USER_ID },
			// V3 on one cluster + one runner.
			{ org_id: ORG_ID, dimension_id: DIM_SINGLE, value_id: V3, resource_kind: "cloud_kubernetes_cluster", resource_id: R_CLUSTER, assigned_by: USER_ID },
			{ org_id: ORG_ID, dimension_id: DIM_SINGLE, value_id: V3, resource_kind: "runner", resource_id: R_RUNNER, assigned_by: USER_ID },
		]);
	});

	afterAll(async () => {
		// Deleting the dimensions cascades their values + assignments.
		await getServiceDb()
			.delete(classificationDimension)
			.where(inArray(classificationDimension.id, [DIM_MULTI, DIM_SINGLE]));
	});

	it("counts assignments (distinct resources) per value; unused values are absent", async () => {
		const byValue = await getServiceDb().transaction((tx) =>
			countAssignmentsByValue(tx),
		);
		expect(byValue.get(V1)).toBe(2);
		expect(byValue.get(V2)).toBe(1);
		expect(byValue.get(V3)).toBe(2);
		expect(byValue.has(V_UNUSED)).toBe(false); // never assigned → absent (0)
	});

	it("counts DISTINCT resources per dimension (no double-count for multi)", async () => {
		const byDim = await getServiceDb().transaction((tx) =>
			countResourcesByDimension(tx),
		);
		// DIM_MULTI: values sum to 3 assignments but only 2 distinct resources (A, B).
		expect(byDim.get(DIM_MULTI)).toBe(2);
		expect(byDim.get(DIM_SINGLE)).toBe(2);
	});

	it("breaks a value's resources down by kind", async () => {
		const [v1, v3] = await getServiceDb().transaction(async (tx) => [
			await countAssignmentsByKindForValue(tx, V1),
			await countAssignmentsByKindForValue(tx, V3),
		]);
		expect(v1).toEqual([{ resource_kind: "project", count: 2 }]);
		// Ordered by kind: cloud_kubernetes_cluster < runner.
		expect(v3).toEqual([
			{ resource_kind: "cloud_kubernetes_cluster", count: 1 },
			{ resource_kind: "runner", count: 1 },
		]);
	});

	it("persists a dimension's applies_to resource-kind scope", async () => {
		const db = getServiceDb();
		const [scoped] = await db
			.select({ applies_to: classificationDimension.applies_to })
			.from(classificationDimension)
			.where(eq(classificationDimension.id, DIM_SINGLE));
		const [unscoped] = await db
			.select({ applies_to: classificationDimension.applies_to })
			.from(classificationDimension)
			.where(eq(classificationDimension.id, DIM_MULTI));
		expect(scoped.applies_to).toEqual(["project_environment"]);
		expect(unscoped.applies_to).toEqual([]); // default = all kinds
	});
});
