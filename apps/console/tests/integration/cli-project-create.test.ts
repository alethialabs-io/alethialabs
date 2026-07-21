// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the shared front-door create-core (`insertProjectWithDefaultFabric`) against real
// Postgres. This is the invariant BOTH the console `createProject` server action AND the CLI route
// `POST /api/cli/projects` run — so a CLI-created project must land in the SAME shape as a
// console-created one (the #904 drift fix). A mock can't catch this: the point is that the real
// inserts produce a default Fabric + Prod(dedicated)/Preview(namespace) envs + the project→org edge,
// and that the enclosing transaction rolls the whole thing back on failure (no orphaned project —
// the exact bug the fabric-less, transaction-less route had). Seeds via the service connection
// (bypasses RLS), uses unique ids, and cleans up after itself.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import {
	projectEnvironments,
	projectFabrics,
	projects,
	resourceHierarchy,
} from "@/lib/db/schema";
import { insertProjectWithDefaultFabric } from "@/lib/queries/projects";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const USER = randomUUID();

describeIfDb("CLI project create — shared front-door core parity (#904)", () => {
	afterAll(async () => {
		const db = getServiceDb();
		// Children first (no cascade assumed): envs + fabrics + hierarchy edges, then projects.
		const rows = await db
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.org_id, ORG));
		for (const { id } of rows) {
			await db
				.delete(projectEnvironments)
				.where(eq(projectEnvironments.project_id, id));
			await db.delete(projectFabrics).where(eq(projectFabrics.project_id, id));
			await db
				.delete(resourceHierarchy)
				.where(
					and(
						eq(resourceHierarchy.child_type, "project"),
						eq(resourceHierarchy.child_id, id),
					),
				);
		}
		await db.delete(projects).where(eq(projects.org_id, ORG));
	});

	it("creates a default Fabric + Prod(dedicated)/Preview(namespace) envs + the project→org edge", async () => {
		const db = getServiceDb();
		const { project } = await db.transaction((tx) =>
			insertProjectWithDefaultFabric(tx, {
				project_name: `p-${randomUUID()}`,
				region: "westeurope",
				iac_version: "1.11.4",
				environment_stage: "production",
				owner: USER,
				orgId: ORG,
			}),
		);

		// Exactly one Fabric, named after the stage, in DRAFT.
		const fabrics = await db
			.select()
			.from(projectFabrics)
			.where(eq(projectFabrics.project_id, project.id));
		expect(fabrics).toHaveLength(1);
		expect(fabrics[0]?.name).toBe("production");
		expect(fabrics[0]?.status).toBe("DRAFT");
		const fabricId = fabrics[0]?.id;

		// Two environments, both on that Fabric, with the placement invariant.
		const envs = await db
			.select()
			.from(projectEnvironments)
			.where(eq(projectEnvironments.project_id, project.id));
		expect(envs).toHaveLength(2);

		const prod = envs.find((e) => e.is_default);
		const preview = envs.find((e) => !e.is_default);
		expect(prod?.placement_mode).toBe("dedicated");
		expect(prod?.stage).toBe("production");
		expect(prod?.fabric_id).toBe(fabricId);
		expect(preview?.placement_mode).toBe("namespace");
		expect(preview?.namespace).toBe("preview");
		expect(preview?.stage).toBe("development");
		expect(preview?.fabric_id).toBe(fabricId);

		// project → org authz hierarchy edge.
		const edges = await db
			.select()
			.from(resourceHierarchy)
			.where(
				and(
					eq(resourceHierarchy.child_type, "project"),
					eq(resourceHierarchy.child_id, project.id),
				),
			);
		expect(edges).toHaveLength(1);
		expect(edges[0]?.parent_type).toBe("org");
		expect(edges[0]?.parent_id).toBe(ORG);
	});

	it("rolls the whole create back on a mid-transaction failure — no orphaned project", async () => {
		const db = getServiceDb();
		const doomedName = `rollback-${randomUUID()}`;

		await expect(
			db.transaction(async (tx) => {
				await insertProjectWithDefaultFabric(tx, {
					project_name: doomedName,
					region: "westeurope",
					iac_version: "1.11.4",
					environment_stage: "production",
					owner: USER,
					orgId: ORG,
				});
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		const leftovers = await db
			.select({ id: projects.id })
			.from(projects)
			.where(
				and(
					eq(projects.org_id, ORG),
					eq(projects.project_name, doomedName),
				),
			);
		expect(leftovers).toHaveLength(0);
	});
});
