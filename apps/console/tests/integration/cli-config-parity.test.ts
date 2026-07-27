// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// TEMPORARY parity guard (Stage 2 of retiring project_full): getCliConfig — the TS successor that
// assembles the flat CLI config from the live component tables — must be wire-identical to the
// `project_full` SQL view (queryProjectFull) for the default environment. Compared JSON-normalized
// (the CLI consumes the JSON, so Date→ISO etc. are what matter). Delete this test in Stage 3 when the
// view is dropped. Requires the CURRENT project_full view (cluster_admins sourced from the child
// table) — authoritative on CI's fresh migrated DB.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { getCliConfig } from "@/lib/queries/cli-config";
import { queryProjectFull } from "@/lib/queries/project-full";
import {
	cloudIdentities,
	clusterAdmins,
	projectCluster,
	projectDatabases,
	projectDns,
	projectEnvironments,
	projectNetwork,
	projects,
} from "@/lib/db/schema";
import { describeIfDb } from "./db";

const USER = randomUUID();
const PROJ = randomUUID();
const ENV = randomUUID();
const IDENTITY = randomUUID();
const CLUSTER = randomUUID();
const NAME = `p-${PROJ}`;

/** Deep value-equality on the JSON wire (what the CLI actually receives). */
const wire = (v: unknown) => JSON.parse(JSON.stringify(v));

describeIfDb("cli-config parity — getCliConfig == project_full view", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await db.insert(cloudIdentities).values({
			id: IDENTITY,
			user_id: USER,
			org_id: USER,
			provider: "aws",
			name: "acct",
			credentials: { account_id: "123456789012" },
		});
		await db.insert(projects).values({
			id: PROJ,
			org_id: USER,
			user_id: USER,
			project_name: NAME,
			region: "eu-west-1",
			iac_version: "1.0",
			cloud_identity_id: IDENTITY,
			estimated_monthly_cost: 42.5,
		});
		await db.insert(projectEnvironments).values({
			id: ENV,
			project_id: PROJ,
			user_id: USER,
			name: "production",
			is_default: true,
			status: "ACTIVE",
		});
		await db.insert(projectNetwork).values({
			project_id: PROJ,
			environment_id: ENV,
			provision_network: true,
			cidr_block: "10.1.0.0/16",
		});
		await db.insert(projectCluster).values({
			id: CLUSTER,
			project_id: PROJ,
			environment_id: ENV,
			cluster_version: "1.30",
			instance_types: ["m5.large"],
			node_min_size: 2,
			node_max_size: 5,
		});
		await db.insert(clusterAdmins).values([
			{ cluster_id: CLUSTER, username: "alice", groups: ["platform"], ordinal: 0 },
		]);
		await db.insert(projectDns).values({
			project_id: PROJ,
			environment_id: ENV,
			enabled: true,
			domain_name: "example.com",
		});
		await db.insert(projectDatabases).values([
			{
				project_id: PROJ,
				environment_id: ENV,
				name: "db",
				min_capacity: 0.5,
				max_capacity: 4,
			},
			{
				project_id: PROJ,
				environment_id: ENV,
				name: "gone",
				min_capacity: 8,
				max_capacity: 16,
				status: "DESTROYED",
			},
		]);
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(projects).where(eq(projects.id, PROJ));
		await db.delete(cloudIdentities).where(eq(cloudIdentities.id, IDENTITY));
	});

	it("is wire-identical to the project_full view for the default env", async () => {
		const db = getServiceDb();
		const [viewRow] = await queryProjectFull(db, {
			user_id: USER,
			project_name: NAME,
		});
		const cli = await getCliConfig(db, { userId: USER, projectName: NAME });
		expect(cli).not.toBeNull();
		// Timestamps differ only in FORMAT: the view (raw db.execute) serializes them as Postgres
		// strings (`… +00`), while getCliConfig emits RFC3339 ISO — which is what the Go CLI's
		// time.Time actually parses. Assert ISO shape, then strip both and compare the rest exactly.
		expect(cli?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
		expect(cli?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
		const strip = (o: unknown) => {
			const w = wire(o);
			delete w.created_at;
			delete w.updated_at;
			return w;
		};
		expect(strip(cli)).toEqual(strip(viewRow));
	});
});
