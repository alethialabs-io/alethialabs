// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: migration 0156's data steps (#5266) against real Postgres.
//
// The same PR changes two template defaults — the node machine type of a cluster that pins none
// (aws/gcp/azure) and the aws capacity type (SPOT → ON_DEMAND). Either would reshape a running
// cluster that relied on it. 0156 writes the OLD value onto every already-provisioned cluster that
// pins nothing. This test runs THE SHIPPED SQL — the text between the migration's BEGIN/END markers,
// read from the file — over seeded rows, asserts each case, then runs it AGAIN and asserts nothing
// moved: the migration is idempotent.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import {
	cloudIdentities,
	jobs,
	projectCluster,
	projectEnvironments,
	projectFabrics,
	projects,
} from "@/lib/db/schema";
import type { CloudProvider, ProjectStatus } from "@/lib/db/schema/enums";
import type { NodeSize } from "@/types/jsonb.types";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const USER = randomUUID();

/** The data section of migration 0156, split into its statements. */
function pinStatements(): string[] {
	const dir = join(__dirname, "../../lib/db/migrations");
	const file = readFileSync(join(dir, "0156_steep_doctor_strange.sql"), "utf8");
	const begin = file.indexOf("-- ── #5266 data: BEGIN");
	const end = file.indexOf("-- ── #5266 data: END");
	if (begin < 0 || end < begin) throw new Error("0156 lost its #5266 data markers");
	return file
		.slice(begin, end)
		.split("--> statement-breakpoint")
		.map((s) => s.trim())
		.filter((s) => s.replace(/--[^\n]*/g, "").trim().length > 0);
}

/** Runs the pin on ONE connection: the steps share session temp tables. */
async function runPin(): Promise<void> {
	const statements = pinStatements();
	await getServiceDb().transaction(async (tx) => {
		for (const statement of statements) await tx.execute(sql.raw(statement));
	});
}

/** A cluster row as the seed writes it; every field optional. */
interface ClusterSeed {
	instance_types?: string[] | null;
	node_size?: NodeSize | null;
	capacity_type?: "on_demand" | "spot" | null;
	provider_config?: Record<string, string>;
	/** The row's own identity, overriding the project's. */
	identity?: string;
}

/** One project's seed: its cloud, its one dedicated environment, the evidence, and a cluster row. */
interface Case {
	provider: CloudProvider;
	envStatus: ProjectStatus;
	deployed: boolean;
	cluster: ClusterSeed | null;
}

const identities = new Map<CloudProvider, string>();

/** Seeds one project for a case and returns its environment id. */
async function seed(c: Case): Promise<string> {
	const db = getServiceDb();
	const projectId = randomUUID();
	const fabricId = randomUUID();
	const envId = randomUUID();
	await db.insert(projects).values({
		id: projectId,
		org_id: ORG,
		user_id: USER,
		project_name: `pin-${projectId}`,
		region: "eu-west-1",
		iac_version: "1.11.4",
		cloud_identity_id: identities.get(c.provider) ?? null,
	});
	await db.insert(projectFabrics).values({ id: fabricId, project_id: projectId, user_id: USER, org_id: ORG, name: "prod" });
	await db.insert(projectEnvironments).values({
		id: envId,
		project_id: projectId,
		user_id: USER,
		name: "prod",
		is_default: true,
		fabric_id: fabricId,
		placement_mode: "dedicated",
		status: c.envStatus,
	});
	if (c.deployed) {
		await db.insert(jobs).values({
			user_id: USER,
			org_id: ORG,
			project_id: projectId,
			environment_id: envId,
			job_type: "DEPLOY",
			status: "SUCCESS",
			config_snapshot: {},
		});
	}
	if (c.cluster) {
		await db.insert(projectCluster).values({
			project_id: projectId,
			environment_id: envId,
			fabric_id: fabricId,
			instance_types: c.cluster.instance_types ?? null,
			node_size: c.cluster.node_size ?? null,
			capacity_type: c.cluster.capacity_type ?? null,
			provider_config: c.cluster.provider_config ?? {},
			cloud_identity_id: c.cluster.identity ?? null,
		});
	}
	return envId;
}

/** The cluster rows serving an environment (env-keyed), in a comparable shape. */
async function clusterOf(envId: string) {
	return getServiceDb()
		.select({
			instance_types: projectCluster.instance_types,
			node_size: projectCluster.node_size,
			capacity_type: projectCluster.capacity_type,
			provider_config: projectCluster.provider_config,
			fabric_id: projectCluster.fabric_id,
			status: projectCluster.status,
		})
		.from(projectCluster)
		.where(eq(projectCluster.environment_id, envId));
}

const env: Record<string, string> = {};

describeIfDb("migration 0156 — pin what provisioned clusters run (#5266)", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		for (const provider of ["aws", "gcp", "azure", "hetzner"] satisfies CloudProvider[]) {
			const [row] = await db
				.insert(cloudIdentities)
				.values({ user_id: USER, org_id: ORG, provider, name: `pin-${provider}-${ORG.slice(0, 8)}` })
				.returning({ id: cloudIdentities.id });
			identities.set(provider, row.id);
		}
		const aws = identities.get("aws");
		env.awsEmpty = await seed({ provider: "aws", envStatus: "ACTIVE", deployed: true, cluster: { instance_types: [] } });
		env.gcpNoRow = await seed({ provider: "gcp", envStatus: "ACTIVE", deployed: true, cluster: null });
		env.awsPinned = await seed({ provider: "aws", envStatus: "ACTIVE", deployed: true, cluster: { instance_types: ["t3.xlarge"] } });
		env.azureSized = await seed({
			provider: "azure",
			envStatus: "ACTIVE",
			deployed: true,
			cluster: { node_size: { vcpu: 4, memory_gb: 16 } },
		});
		env.awsDraft = await seed({ provider: "aws", envStatus: "DRAFT", deployed: false, cluster: { instance_types: [] } });
		env.awsDestroyed = await seed({ provider: "aws", envStatus: "DESTROYED", deployed: true, cluster: { instance_types: null } });
		env.hetznerNoRow = await seed({ provider: "hetzner", envStatus: "ACTIVE", deployed: true, cluster: null });
		env.awsOnDemand = await seed({
			provider: "aws",
			envStatus: "FAILED",
			deployed: true,
			cluster: { instance_types: null, capacity_type: "on_demand" },
		});
		env.awsPassthrough = await seed({
			provider: "aws",
			envStatus: "DRAFT",
			deployed: false,
			cluster: { instance_types: ["t3.large"], provider_config: { eks_ng_capacity_type: "ON_DEMAND", other: "kept" } },
		});
		env.gcpProjectAwsRow = await seed({
			provider: "gcp",
			envStatus: "ACTIVE",
			deployed: true,
			cluster: { instance_types: [], identity: aws },
		});

		await runPin();
	});

	afterAll(async () => {
		const db = getServiceDb();
		const rows = await db.select({ id: projects.id }).from(projects).where(eq(projects.org_id, ORG));
		const ids = rows.map((r) => r.id);
		if (ids.length > 0) {
			await db.delete(jobs).where(inArray(jobs.project_id, ids));
			await db.delete(projectCluster).where(inArray(projectCluster.project_id, ids));
			await db.delete(projectEnvironments).where(inArray(projectEnvironments.project_id, ids));
			await db.delete(projectFabrics).where(inArray(projectFabrics.project_id, ids));
			await db.delete(projects).where(eq(projects.org_id, ORG));
		}
		await db.delete(cloudIdentities).where(eq(cloudIdentities.org_id, ORG));
	});

	it("aws, provisioned, pinning nothing: the old machine type AND spot", async () => {
		const [row] = await clusterOf(env.awsEmpty);
		expect(row?.instance_types).toEqual(["m5a.4xlarge"]);
		expect(row?.capacity_type).toBe("spot");
	});

	it("gcp, provisioned with NO cluster row: the row is created with the old machine type", async () => {
		const rows = await clusterOf(env.gcpNoRow);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.instance_types).toEqual(["e2-standard-4"]);
		expect(rows[0]?.capacity_type).toBeNull();
		expect(rows[0]?.fabric_id).not.toBeNull();
		expect(rows[0]?.status).toBe("ACTIVE");
	});

	it("a pinned machine type is kept; an aws one still gets spot, which it ran on", async () => {
		const [row] = await clusterOf(env.awsPinned);
		expect(row?.instance_types).toEqual(["t3.xlarge"]);
		expect(row?.capacity_type).toBe("spot");
	});

	it("a node_size is a pin: no machine type is written beside it", async () => {
		const [row] = await clusterOf(env.azureSized);
		expect(row?.instance_types).toBeNull();
		expect(row?.node_size).toEqual({ vcpu: 4, memory_gb: 16 });
	});

	it("never-provisioned and destroyed environments are left for the new defaults", async () => {
		for (const id of [env.awsDraft, env.awsDestroyed]) {
			const [row] = await clusterOf(id);
			expect(row?.capacity_type).toBeNull();
			expect(row?.instance_types ?? []).toEqual([]);
		}
	});

	it("hetzner's default did not move, so no row is created for it", async () => {
		expect(await clusterOf(env.hetznerNoRow)).toHaveLength(0);
	});

	it("an explicit capacity type is kept", async () => {
		const [row] = await clusterOf(env.awsOnDemand);
		expect(row?.capacity_type).toBe("on_demand");
		expect(row?.instance_types).toEqual(["m5a.4xlarge"]);
	});

	it("a hand-set eks_ng_capacity_type passthrough moves onto the column and leaves provider_config", async () => {
		const [row] = await clusterOf(env.awsPassthrough);
		expect(row?.capacity_type).toBe("on_demand");
		expect(row?.provider_config).toEqual({ other: "kept" });
	});

	it("the provider is the row's own identity first, as the snapshot resolves it", async () => {
		const [row] = await clusterOf(env.gcpProjectAwsRow);
		expect(row?.instance_types).toEqual(["m5a.4xlarge"]);
		expect(row?.capacity_type).toBe("spot");
	});

	it("is idempotent: a second run changes nothing", async () => {
		const before = await Promise.all(Object.values(env).map(clusterOf));
		await runPin();
		const after = await Promise.all(Object.values(env).map(clusterOf));
		expect(after).toEqual(before);
	});
});
