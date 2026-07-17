// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: `alethia project component add` for a SINGLETON (#662). A mock can't catch this — the
// bug WAS the SQL: the component tables are UNIQUE on the composite (project_id, environment_id), so
// an insert that leaves environment_id NULL and upserts ON CONFLICT (project_id) errors against real
// Postgres. Seed a project + two environments via the service connection (bypasses RLS) and assert the
// default env is chosen, the row carries it, and a re-add upserts rather than erroring or duplicating.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { insertProjectComponent } from "@/lib/cli/project-components";
import { resolveDefaultEnvironmentId } from "@/lib/cli/resolve-project";
import { getServiceDb } from "@/lib/db";
import {
	projectCluster,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const USER = randomUUID();
const PROJ = randomUUID();
const ENV_DEFAULT = randomUUID();
const ENV_OTHER = randomUUID();

describeIfDb("CLI project component add — environment scoping (#662)", () => {
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
		// Two envs; the non-default is created first, so a naive "earliest" pick would get it wrong —
		// the resolver must prefer is_default.
		await db.insert(projectEnvironments).values({
			id: ENV_OTHER,
			project_id: PROJ,
			user_id: USER,
			name: "staging",
			is_default: false,
		});
		await db.insert(projectEnvironments).values({
			id: ENV_DEFAULT,
			project_id: PROJ,
			user_id: USER,
			name: "production",
			is_default: true,
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(projectCluster).where(eq(projectCluster.project_id, PROJ));
		await db.delete(projectEnvironments).where(eq(projectEnvironments.project_id, PROJ));
		await db.delete(projects).where(eq(projects.id, PROJ));
	});

	it("resolves the project's is_default environment", async () => {
		expect(await resolveDefaultEnvironmentId(PROJ)).toBe(ENV_DEFAULT);
	});

	it("adds a singleton cluster carrying the default environment", async () => {
		const wire = await insertProjectComponent("cluster", PROJ, ENV_DEFAULT, "", {
			node_desired_size: 2,
			instance_types: ["Standard_D2s_v3"],
		});
		expect(wire).toBeTruthy();

		const rows = await getServiceDb()
			.select()
			.from(projectCluster)
			.where(eq(projectCluster.project_id, PROJ));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.environment_id).toBe(ENV_DEFAULT);
		expect(rows[0]?.node_desired_size).toBe(2);
	});

	it("re-adds via the composite upsert — updates in place, never errors or duplicates", async () => {
		await insertProjectComponent("cluster", PROJ, ENV_DEFAULT, "", {
			node_desired_size: 4,
			instance_types: ["Standard_D2s_v3"],
		});

		const rows = await getServiceDb()
			.select()
			.from(projectCluster)
			.where(eq(projectCluster.project_id, PROJ));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.node_desired_size).toBe(4);
		expect(rows[0]?.environment_id).toBe(ENV_DEFAULT);
	});
});
