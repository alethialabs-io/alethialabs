// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the W2 BUILD enqueue entrypoint (#605): buildProject queues a
// BUILD with the env's frozen snapshot off an ACTIVE environment, and provisionProject
// reroutes to build-then-deploy exactly when (a) the env is ACTIVE, (b) the snapshot
// carries a repo-sourced service, and (c) no gated plan is being applied. Same harness
// shape as projects.test.ts (thenable drizzle chain through withOwnerScope).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/db", () => ({
	withOwnerScope: vi.fn(),
	withScope: vi.fn(),
	getServiceDb: vi.fn(),
}));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/lib/auth/owner", () => ({ requireOwner: vi.fn() }));
vi.mock("@/lib/billing/usage-guard", () => ({ assertUsageAllowed: vi.fn() }));
vi.mock("@/lib/authz/tuple-sync", () => ({ mirrorHierarchyEdge: vi.fn() }));

import { buildProject, provisionProject } from "@/app/server/actions/projects";
import { requireOwner } from "@/lib/auth/owner";
import { authorize } from "@/lib/authz/guard";
import { assertUsageAllowed } from "@/lib/billing/usage-guard";
import { getServiceDb, withOwnerScope } from "@/lib/db";
import {
	auditLog,
	cloudIdentities,
	jobs,
	projectEnvironments,
	projectServices,
	projects,
} from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";

type Rows = unknown[];

/** Table-aware thenable drizzle-ish tx wired through withOwnerScope (projects.test.ts shape). */
function setupDb(select: Map<unknown, Rows>, insert: Map<unknown, Rows>) {
	const valuesSpy = vi.fn<(table: unknown, payload: unknown) => void>();
	const executeSpy = vi.fn();
	function makeChain(op: "select" | "insert", table?: unknown) {
		let from = table;
		const c: Record<string, unknown> = {};
		Object.assign(c, {
			from: (t: unknown) => {
				from = t;
				return c;
			},
			leftJoin: () => c,
			innerJoin: () => c,
			where: () => c,
			limit: () => c,
			orderBy: () => c,
			onConflictDoNothing: () => c,
			returning: () => c,
			values: (payload: unknown) => {
				valuesSpy(from, payload);
				return c;
			},
			then: (res: (v: Rows) => void) =>
				res(op === "insert" ? (insert.get(from) ?? []) : (select.get(from) ?? [])),
		});
		return c;
	}
	const tx = {
		select: () => makeChain("select"),
		insert: (t: unknown) => makeChain("insert", t),
		update: () => makeChain("select"),
		delete: () => makeChain("select"),
		// env-status CAS (set_env_status): env moved.
		execute: (q: unknown) => {
			executeSpy(q);
			return Promise.resolve([{ updated: true }]);
		},
	};
	vi.mocked(withOwnerScope).mockImplementation(
		((_owner: string, cb: (tx: unknown) => unknown) => cb(tx)) as never,
	);
	vi.mocked(getServiceDb).mockReturnValue({} as never);
	return { valuesSpy, executeSpy };
}

/** Pulls the `.values()` payload recorded against a given schema table. */
function valuesFor(spy: ReturnType<typeof vi.fn>, table: unknown): Record<string, unknown> {
	const call = spy.mock.calls.find((c) => c[0] === table);
	if (!call) throw new Error("no values() recorded for table");
	return call[1] as Record<string, unknown>;
}

const repoServiceRow = {
	id: "svc-web",
	project_id: "p1",
	environment_id: "env-1",
	name: "web",
	cloud_identity_id: null,
	region: null,
	type: "deployment",
	source: { kind: "repo", repo_url: "https://github.com/acme/web", path: "" },
	build: null,
	env: [],
	ports: [],
	replicas: 2,
	resources: null,
	probe: null,
	resolved_image: null,
	status: "PENDING",
	status_message: null,
	estimated_monthly_cost: null,
	created_at: "2026-01-01T00:00:00.000Z",
	updated_at: "2026-01-01T00:00:00.000Z",
};

const imageServiceRow = {
	...repoServiceRow,
	id: "svc-worker",
	name: "worker",
	source: { kind: "image", image: "ghcr.io/acme/worker:1.2.3" },
};

/** Select map sufficient for buildConfigSnapshot; env status + service rows vary per test. */
function snapshotSelect(envStatus: string, services: Rows) {
	return new Map<unknown, Rows>([
		[projects, [{ id: "p1", org_id: "org-1", cloud_identity_id: "ci-1", region: "us-east-1" }]],
		[
			projectEnvironments,
			[
				{
					id: "env-1",
					name: "production",
					stage: "production",
					status: envStatus,
					is_default: true,
					region: null,
				},
			],
		],
		[cloudIdentities, [{ id: "ci-1", provider: "aws" }]],
		[projectServices, services],
	]);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue({ userId: "user-1", orgId: "org-1" } as never);
	vi.mocked(requireOwner).mockResolvedValue("user-1" as never);
	vi.mocked(assertUsageAllowed).mockResolvedValue(undefined as never);
});

describe("buildProject", () => {
	it("queues a BUILD with the env's frozen snapshot off an ACTIVE environment", async () => {
		const { valuesSpy, executeSpy } = setupDb(
			snapshotSelect("ACTIVE", [repoServiceRow, imageServiceRow]),
			new Map([[jobs, [{ id: "job-b1" }]]]),
		);

		const r = await buildProject("p1");

		expect(authorize).toHaveBeenCalledWith("deploy", { type: "project", id: "p1" });
		expect(assertUsageAllowed).toHaveBeenCalledWith("org-1");
		const jobVals = valuesFor(valuesSpy, jobs);
		expect(jobVals).toMatchObject({
			user_id: "user-1",
			project_id: "p1",
			environment_id: "env-1",
			cloud_identity_id: "ci-1",
			job_type: "BUILD",
			status: "QUEUED",
		});
		// The frozen snapshot carries the services the BUILD consumes (repo-sourced included).
		const snapshot = jobVals.config_snapshot as { services: { name: string }[] };
		expect(snapshot.services.map((s) => s.name)).toEqual(["web", "worker"]);
		expect(jobVals.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
		expect(valuesFor(valuesSpy, auditLog)).toMatchObject({
			action: "PROVISIONED",
			changes: { job_id: "job-b1", environment_id: "env-1", job_type: "BUILD" },
		});
		expect(executeSpy).toHaveBeenCalled(); // env→QUEUED CAS
		expect(notifyScaler).toHaveBeenCalledTimes(1);
		expect(r).toEqual({ jobId: "job-b1" });
	});

	it("refuses when the environment has no repo-sourced services", async () => {
		setupDb(
			snapshotSelect("ACTIVE", [imageServiceRow]),
			new Map([[jobs, [{ id: "job-b1" }]]]),
		);
		await expect(buildProject("p1")).rejects.toThrow(/no repo-sourced services/i);
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("refuses when the environment's infra is not up (build runs in-cluster)", async () => {
		setupDb(
			snapshotSelect("DRAFT", [repoServiceRow]),
			new Map([[jobs, [{ id: "job-b1" }]]]),
		);
		await expect(buildProject("p1")).rejects.toThrow(/provision the infrastructure/i);
		expect(notifyScaler).not.toHaveBeenCalled();
	});
});

describe("provisionProject — W2 build-then-deploy rerouting", () => {
	it("queues BUILD first on an ACTIVE env with repo-sourced services (the chain deploys)", async () => {
		const { valuesSpy } = setupDb(
			snapshotSelect("ACTIVE", [repoServiceRow]),
			new Map([[jobs, [{ id: "job-b2" }]]]),
		);

		const r = await provisionProject("p1");

		expect(valuesFor(valuesSpy, jobs)).toMatchObject({ job_type: "BUILD" });
		expect(r).toEqual({ jobId: "job-b2", jobType: "BUILD" });
	});

	it("deploys directly when there are no repo-sourced services", async () => {
		const { valuesSpy } = setupDb(
			snapshotSelect("ACTIVE", [imageServiceRow]),
			new Map([[jobs, [{ id: "job-d1" }]]]),
		);

		const r = await provisionProject("p1");

		expect(valuesFor(valuesSpy, jobs)).toMatchObject({ job_type: "DEPLOY" });
		expect(r).toEqual({ jobId: "job-d1" });
	});

	it("deploys infra directly on first provision (env not ACTIVE) even with repo services", async () => {
		const { valuesSpy } = setupDb(
			snapshotSelect("DRAFT", [repoServiceRow]),
			new Map([[jobs, [{ id: "job-d2" }]]]),
		);

		const r = await provisionProject("p1");

		expect(valuesFor(valuesSpy, jobs)).toMatchObject({ job_type: "DEPLOY" });
		expect(r).toEqual({ jobId: "job-d2" });
	});

	it("never reroutes a gated plan→apply (planJobId applies exactly the reviewed plan)", async () => {
		const { valuesSpy } = setupDb(
			snapshotSelect("ACTIVE", [repoServiceRow]),
			new Map([[jobs, [{ id: "job-d3" }]]]),
		);

		const r = await provisionProject("p1", "plan-9");

		expect(valuesFor(valuesSpy, jobs)).toMatchObject({
			job_type: "DEPLOY",
			plan_job_id: "plan-9",
		});
		expect(r).toEqual({ jobId: "job-d3" });
	});
});
