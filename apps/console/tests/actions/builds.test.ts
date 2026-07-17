// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the W2 build finalizers (app/server/actions/builds.ts), mirroring
// the finalizeDeployment test harness: a thenable drizzle chain resolves the job SELECT to a
// seeded row, captures each update().set().where() and insert().values().returning(), and the
// env-status CAS resolves via db.execute. We assert the early-return guards, that each service's
// resolved_image is written, and that the DEPLOY is chained (or skipped on a lost CAS race).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import {
	enqueueDeployAfterBuild,
	finalizeBuild,
} from "@/app/server/actions/builds";
import { getServiceDb } from "@/lib/db";
import { jobs, projectServices } from "@/lib/db/schema";

type Update = { table: unknown; set: Record<string, unknown> | undefined; where: boolean };
type Insert = { table: unknown; values: Record<string, unknown> | undefined };

/**
 * A drizzle-ish chain: builders return the chain, the chain is thenable (resolving the seeded
 * `rows` for the SELECT + awaited writes), the env-status CAS resolves via execute, and each
 * update()/insert() is recorded so tests can assert what was written.
 */
function mockDb(rows: unknown[], opts?: { casUpdated?: boolean }) {
	const updates: Update[] = [];
	const inserts: Insert[] = [];
	const casUpdated = opts?.casUpdated ?? true;
	let curUpdate: Update | null = null;
	let curInsert: Insert | null = null;
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: () => {
			if (curUpdate) curUpdate.where = true;
			return db;
		},
		limit: () => db,
		update: (table: unknown) => {
			curUpdate = { table, set: undefined, where: false };
			updates.push(curUpdate);
			return db;
		},
		set: (vals: Record<string, unknown>) => {
			if (curUpdate) curUpdate.set = vals;
			return db;
		},
		insert: (table: unknown) => {
			curInsert = { table, values: undefined };
			inserts.push(curInsert);
			return db;
		},
		values: (vals: Record<string, unknown>) => {
			if (curInsert) curInsert.values = vals;
			return db;
		},
		returning: () => Promise.resolve([{ id: "deploy-1" }]),
		// The env-status CAS (transitionEnv → db.execute<{updated}>): true = env legitimately moved.
		execute: () => Promise.resolve([{ updated: casUpdated }]),
		then: (resolve: (v: unknown) => void) => resolve(rows),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return {
		updates,
		inserts,
		writesFor: (table: unknown) => updates.filter((u) => u.table === table),
	};
}

function buildJob(over?: Record<string, unknown>) {
	return {
		status: "SUCCESS",
		job_type: "BUILD",
		user_id: "user-1",
		org_id: "org-1",
		project_id: "proj-1",
		environment_id: "env-1",
		cloud_identity_id: "ci-1",
		config_snapshot: { services: [{ name: "api" }] },
		execution_metadata: {
			build_result: {
				api: "111.dkr.ecr.eu-central-1.amazonaws.com/api@sha256:aaa",
				web: "111.dkr.ecr.eu-central-1.amazonaws.com/web@sha256:bbb",
			},
		},
		...over,
	};
}

beforeEach(() => vi.clearAllMocks());

describe("finalizeBuild", () => {
	it("persists each service's built digest into project_services.resolved_image", async () => {
		const h = mockDb([buildJob()]);
		await finalizeBuild("job-1");

		const svcWrites = h.writesFor(projectServices);
		expect(svcWrites).toHaveLength(2);
		const images = svcWrites.map((w) => w.set?.resolved_image).sort();
		expect(images).toEqual([
			"111.dkr.ecr.eu-central-1.amazonaws.com/api@sha256:aaa",
			"111.dkr.ecr.eu-central-1.amazonaws.com/web@sha256:bbb",
		]);
		// Every write is env-scoped (has a where clause) and stamps updated_at.
		expect(svcWrites.every((w) => w.where && w.set?.updated_at instanceof Date)).toBe(true);
	});

	it("no-ops for a non-SUCCESS build", async () => {
		const h = mockDb([buildJob({ status: "FAILED" })]);
		await finalizeBuild("job-1");
		expect(h.writesFor(projectServices)).toHaveLength(0);
	});

	it("no-ops for a non-BUILD job type", async () => {
		const h = mockDb([buildJob({ job_type: "DEPLOY" })]);
		await finalizeBuild("job-1");
		expect(h.writesFor(projectServices)).toHaveLength(0);
	});

	it("no-ops when build_result is absent", async () => {
		const h = mockDb([buildJob({ execution_metadata: {} })]);
		await finalizeBuild("job-1");
		expect(h.writesFor(projectServices)).toHaveLength(0);
	});

	it("no-ops when the job row is missing", async () => {
		const h = mockDb([]);
		await finalizeBuild("job-1");
		expect(h.writesFor(projectServices)).toHaveLength(0);
	});

	it("skips empty image entries", async () => {
		const h = mockDb([
			buildJob({ execution_metadata: { build_result: { api: "digest", web: "" } } }),
		]);
		await finalizeBuild("job-1");
		expect(h.writesFor(projectServices)).toHaveLength(1);
	});
});

describe("enqueueDeployAfterBuild", () => {
	it("chains a DEPLOY reusing the build job's snapshot when the CAS moves the env", async () => {
		const h = mockDb([buildJob()], { casUpdated: true });
		const res = await enqueueDeployAfterBuild("job-1");

		const deployInserts = h.inserts.filter((i) => i.table === jobs);
		expect(deployInserts).toHaveLength(1);
		expect(deployInserts[0].values?.job_type).toBe("DEPLOY");
		expect(deployInserts[0].values?.status).toBe("QUEUED");
		expect(deployInserts[0].values?.config_snapshot).toEqual({ services: [{ name: "api" }] });
		expect(res).toEqual({ deployJobId: "deploy-1" });
	});

	it("does NOT insert an orphan DEPLOY when the env CAS loses the race", async () => {
		const h = mockDb([buildJob()], { casUpdated: false });
		const res = await enqueueDeployAfterBuild("job-1");
		expect(h.inserts.filter((i) => i.table === jobs)).toHaveLength(0);
		expect(res).toBeUndefined();
	});

	it("no-ops for a non-SUCCESS build", async () => {
		const h = mockDb([buildJob({ status: "FAILED" })], { casUpdated: true });
		await enqueueDeployAfterBuild("job-1");
		expect(h.inserts.filter((i) => i.table === jobs)).toHaveLength(0);
	});
});
