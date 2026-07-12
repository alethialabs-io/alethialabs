// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for finalizeDeployment: stub a thenable drizzle chain (so the job SELECT
// resolves to a seeded row and each `update().set().where()` is captured), keep the real zod
// metadata parser + extractOutputValue helper, and assert the early-return guards plus exactly
// which component tables get written with which values on the success path.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import { finalizeDeployment } from "@/app/server/actions/deployments";
import { getServiceDb } from "@/lib/db";
import {
	projectCaches,
	projectCluster,
	projectDatabases,
	projectEnvironments,
	projectIacSources,
} from "@/lib/db/schema";

type Captured = { table: unknown; set: Record<string, unknown> | undefined };

/**
 * A drizzle-ish chain: every builder returns the chain, the chain is thenable
 * (resolving the seeded `jobRows` for the SELECT and for awaited writes), and
 * each `update(table).set(values)` is recorded so tests can assert the writes.
 */
function mockDb(jobRows: unknown[], opts?: { casUpdated?: boolean }) {
	const updates: Captured[] = [];
	// The CAS RPC (set_env_status via db.execute) result — true = env legitimately moved.
	const casUpdated = opts?.casUpdated ?? true;
	const executeCalls: unknown[] = [];
	let current: Captured | null = null;
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: () => db,
		limit: () => db,
		update: (table: unknown) => {
			current = { table, set: undefined };
			updates.push(current);
			return db;
		},
		set: (vals: Record<string, unknown>) => {
			if (current) current.set = vals;
			return db;
		},
		// The env-status CAS goes through db.execute<{updated}>(...) — return the seeded result.
		execute: (query: unknown) => {
			executeCalls.push(query);
			return Promise.resolve([{ updated: casUpdated }]);
		},
		then: (resolve: (v: unknown) => void) => resolve(jobRows),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return {
		updates,
		executeCalls,
		/** Find the captured write for a given schema table (by reference). */
		writeFor: (table: unknown) => updates.find((u) => u.table === table),
	};
}

/** A complete, successful DEPLOY job row with full terraform outputs. */
function fullJob() {
	return {
		status: "SUCCESS",
		project_id: "proj-1",
		environment_id: "env-1",
		job_type: "DEPLOY",
		execution_metadata: {
			cluster_name: "eks-prod",
			cluster_endpoint: "https://eks.example",
			argocd_url: "https://argo.example",
			argocd_admin_password: "s3cret",
			outputs: {
				// object {value} form — exercises extractOutputValue's unwrap branch
				eks_cluster_arn: { value: "arn:aws:eks:cluster" },
				// raw-string form
				rds_cluster_endpoint: "rds.example:5432",
				rds_cluster_identifier: "rds-prod",
				rds_cluster_arn: "arn:aws:rds:cluster",
				rds_master_credentials_secret_arn: "arn:secret:master",
				rds_extra_credentials_secret_arn: "arn:secret:extra",
				rds_credentials_kms_key_arn: "arn:kms:key",
				redis_primary_endpoint_address: "redis.example:6379",
				redis_reader_endpoint_address: "redis-ro.example:6379",
			},
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("finalizeDeployment — guards (no writes)", () => {
	it("does nothing when the job is not found", async () => {
		const { updates } = mockDb([]);
		await expect(finalizeDeployment("job-x")).resolves.toBeUndefined();
		expect(updates).toHaveLength(0);
	});

	it("does nothing when the job did not succeed", async () => {
		const { updates } = mockDb([{ ...fullJob(), status: "FAILED" }]);
		await finalizeDeployment("job-1");
		expect(updates).toHaveLength(0);
	});

	it("does nothing for a non-BYO DESTROY (no iac_source in the snapshot)", async () => {
		const { updates } = mockDb([{ ...fullJob(), job_type: "DESTROY" }]);
		await finalizeDeployment("job-1");
		expect(updates).toHaveLength(0);
	});

	it("does nothing when the job is neither DEPLOY nor DESTROY", async () => {
		const { updates } = mockDb([{ ...fullJob(), job_type: "PLAN" }]);
		await finalizeDeployment("job-1");
		expect(updates).toHaveLength(0);
	});

	it("does nothing when the job has no project_id", async () => {
		const { updates } = mockDb([{ ...fullJob(), project_id: null }]);
		await finalizeDeployment("job-1");
		expect(updates).toHaveLength(0);
	});

	it("does nothing when execution_metadata is absent", async () => {
		const { updates } = mockDb([{ ...fullJob(), execution_metadata: null }]);
		await finalizeDeployment("job-1");
		expect(updates).toHaveLength(0);
	});
});

describe("finalizeDeployment — success path", () => {
	it("persists cluster, database, cache and environment from full outputs", async () => {
		const { updates, writeFor, executeCalls } = mockDb([fullJob()]);
		await finalizeDeployment("job-1");

		// All four component tables written exactly once.
		expect(updates).toHaveLength(4);

		// Env status moves to ACTIVE via the set_env_status CAS (db.execute), not a bare .set().
		expect(executeCalls.length).toBeGreaterThan(0);

		const cluster = writeFor(projectCluster)?.set;
		expect(cluster).toMatchObject({
			status: "ACTIVE",
			cluster_name: "eks-prod",
			cluster_endpoint: "https://eks.example",
			argocd_url: "https://argo.example",
			argocd_admin_password: "s3cret",
			provider_outputs: { arn: "arn:aws:eks:cluster" }, // {value} unwrapped
		});

		const dbWrite = writeFor(projectDatabases)?.set;
		expect(dbWrite).toMatchObject({
			endpoint: "rds.example:5432",
			status: "ACTIVE",
			provider_outputs: {
				identifier: "rds-prod",
				arn: "arn:aws:rds:cluster",
				secret_ref: "arn:secret:master",
				extra_secret_ref: "arn:secret:extra",
				kms_key: "arn:kms:key",
			},
		});

		const cache = writeFor(projectCaches)?.set;
		expect(cache).toMatchObject({
			endpoint: "redis.example:6379",
			status: "ACTIVE",
			reader_endpoint: "redis-ro.example:6379",
		});

		// The .set() carries only the day-2 governance fields; status is not written here anymore.
		expect(writeFor(projectEnvironments)?.set).toMatchObject({
			auto_heal_failures: 0,
			deployed_config_hash: expect.any(String),
			last_deployed_at: expect.any(Date),
		});
		expect(writeFor(projectEnvironments)?.set).not.toHaveProperty("status");
	});

	it("marks the cluster ACTIVE but skips db/cache when outputs are empty", async () => {
		const job = fullJob();
		job.execution_metadata.outputs = {} as never;
		const { updates, writeFor, executeCalls } = mockDb([job]);
		await finalizeDeployment("job-1");

		// cluster (no provider_outputs) + environment governance-fields only.
		expect(updates).toHaveLength(2);
		const cluster = writeFor(projectCluster)?.set;
		expect(cluster).toMatchObject({ status: "ACTIVE", cluster_name: "eks-prod" });
		expect(cluster).not.toHaveProperty("provider_outputs");
		expect(writeFor(projectDatabases)).toBeUndefined();
		expect(writeFor(projectCaches)).toBeUndefined();
		expect(executeCalls.length).toBeGreaterThan(0);
		expect(writeFor(projectEnvironments)?.set).toMatchObject({
			auto_heal_failures: 0,
			deployed_config_hash: expect.any(String),
			last_deployed_at: expect.any(Date),
		});
		expect(writeFor(projectEnvironments)?.set).not.toHaveProperty("status");
	});

	it("writes NOTHING (env + all child rows) when the env-status CAS is rejected (lost race)", async () => {
		// A late DEPLOY-SUCCESS after the env already moved on (e.g. a DESTROY tore it down) — the CAS
		// is hoisted to the top of the DEPLOY block and returns false, so finalizeDeployment must write
		// NOTHING: not the env governance fields AND not the child cluster/db/cache rows (whose live
		// endpoints are the more visible resurrection). This is the P1-1 fix — previously the child
		// rows were written unconditionally before the CAS, resurrecting a torn-down env's metadata.
		const { updates, writeFor, executeCalls } = mockDb([fullJob()], { casUpdated: false });
		await finalizeDeployment("job-1");

		expect(executeCalls.length).toBeGreaterThan(0); // the CAS itself ran
		expect(updates).toHaveLength(0); // ...and rejected → zero writes
		expect(writeFor(projectCluster)).toBeUndefined();
		expect(writeFor(projectDatabases)).toBeUndefined();
		expect(writeFor(projectCaches)).toBeUndefined();
		expect(writeFor(projectEnvironments)).toBeUndefined();
	});

	it("does nothing when the job has no environment_id", async () => {
		// Components are environment-scoped, so a job without a target environment has no
		// rows to write — finalizeDeployment early-returns (deployments.ts) and writes nothing.
		const job = fullJob();
		job.environment_id = null as never;
		const { updates } = mockDb([job]);
		await finalizeDeployment("job-1");
		expect(updates).toHaveLength(0);
	});

	it("ignores non-string metadata fields via the lenient zod parser", async () => {
		const job = fullJob();
		// Wrong types: zod `.catch(undefined)` drops them, so the conditional
		// assignments in the action never fire.
		job.execution_metadata.cluster_name = 123 as never;
		job.execution_metadata.argocd_url = { not: "a string" } as never;
		job.execution_metadata.outputs = {} as never;
		const { writeFor } = mockDb([job]);
		await finalizeDeployment("job-1");

		const cluster = writeFor(projectCluster)?.set;
		expect(cluster).toMatchObject({ status: "ACTIVE" });
		expect(cluster).not.toHaveProperty("cluster_name");
		// argocd_url is a full mirror of the deploy result: a dropped/absent value CLEARS
		// the column (the runner only reports it when an ingress actually exists).
		expect(cluster).toMatchObject({ argocd_url: null });
		// the valid string field still flows through
		expect(cluster).toMatchObject({ cluster_endpoint: "https://eks.example" });
	});

	it("clears a stale argocd_url when the deploy reports no ingress", async () => {
		const job = fullJob();
		const { argocd_url: _omitted, ...withoutUrl } = job.execution_metadata;
		const { writeFor } = mockDb([{ ...job, execution_metadata: withoutUrl }]);
		await finalizeDeployment("job-1");

		expect(writeFor(projectCluster)?.set).toMatchObject({ argocd_url: null });
	});

	it("omits the redis reader endpoint when only the primary is present", async () => {
		const job = fullJob();
		job.execution_metadata.outputs = {
			redis_primary_endpoint_address: "redis.example:6379",
		} as never;
		const { writeFor } = mockDb([job]);
		await finalizeDeployment("job-1");

		const cache = writeFor(projectCaches)?.set;
		expect(cache).toMatchObject({ endpoint: "redis.example:6379", status: "ACTIVE" });
		expect(cache).not.toHaveProperty("reader_endpoint");
		// rds absent → no database write
		expect(writeFor(projectDatabases)).toBeUndefined();
	});
});

describe("finalizeDeployment — BYO IaC deployed-commit tracking", () => {
	it("records the applied commit onto the iac source on a BYO DEPLOY success", async () => {
		const job = { ...fullJob(), config_snapshot: { iac_source: { commit_sha: "cafed00d" } } };
		const { writeFor } = mockDb([job]);
		await finalizeDeployment("job-1");
		expect(writeFor(projectIacSources)?.set).toMatchObject({
			deployed_commit_sha: "cafed00d",
		});
	});

	it("clears deployed_commit_sha on a BYO DESTROY success (detach unblocked)", async () => {
		const job = {
			...fullJob(),
			job_type: "DESTROY",
			config_snapshot: { iac_source: { commit_sha: "cafed00d" } },
		};
		const { updates, writeFor } = mockDb([job]);
		await finalizeDeployment("job-1");
		// A DESTROY carries no tofu outputs — the pin clear is the ONLY write.
		expect(updates).toHaveLength(1);
		expect(writeFor(projectIacSources)?.set).toMatchObject({ deployed_commit_sha: null });
	});

	it("writes no iac-source row for a template DEPLOY (no iac_source in the snapshot)", async () => {
		const { writeFor } = mockDb([fullJob()]);
		await finalizeDeployment("job-1");
		expect(writeFor(projectIacSources)).toBeUndefined();
	});
});
