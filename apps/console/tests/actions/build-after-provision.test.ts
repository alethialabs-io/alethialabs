// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for enqueueBuildAfterProvision — the auto-build trigger that closes the
// repo→running loop. On a SUCCESS DEPLOY into an ACTIVE env with an unbuilt repo-sourced service,
// it enqueues one BUILD (reusing the deploy's snapshot); it no-ops otherwise (already built, no
// repo services, env not ACTIVE, wrong job type, or a lost env CAS). The mock returns a QUEUE of
// results (job → env → services selects), then the CAS via db.execute, then insert().returning().

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import { enqueueBuildAfterProvision } from "@/app/server/actions/builds";
import { getServiceDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema";

type Insert = { table: unknown; values: Record<string, unknown> | undefined };

/** Each awaited select resolves the next queued rows; the env-status CAS resolves via execute. */
function mockDb(selectQueue: unknown[][], opts?: { casUpdated?: boolean }) {
	const inserts: Insert[] = [];
	const casUpdated = opts?.casUpdated ?? true;
	let sel = 0;
	let curInsert: Insert | null = null;
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: () => db,
		limit: () => db,
		insert: (table: unknown) => {
			curInsert = { table, values: undefined };
			inserts.push(curInsert);
			return db;
		},
		values: (v: Record<string, unknown>) => {
			if (curInsert) curInsert.values = v;
			return db;
		},
		returning: () => Promise.resolve([{ id: "build-1" }]),
		execute: () => Promise.resolve([{ updated: casUpdated }]),
		then: (resolve: (v: unknown) => void) => resolve(selectQueue[sel++] ?? []),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return { inserts };
}

const DEPLOY = {
	status: "SUCCESS",
	job_type: "DEPLOY",
	user_id: "u1",
	org_id: "o1",
	project_id: "p1",
	environment_id: "e1",
	cloud_identity_id: "ci1",
	config_snapshot: { services: [{ name: "api" }] },
};
const ACTIVE = { status: "ACTIVE" };
const repoUnbuilt = { source: { kind: "repo" }, resolvedImage: null };
const repoBuilt = { source: { kind: "repo" }, resolvedImage: "ecr/api@sha256:x" };
const prebuilt = { source: { kind: "image" }, resolvedImage: null };

beforeEach(() => vi.clearAllMocks());

const buildInserts = (h: { inserts: Insert[] }) =>
	h.inserts.filter((i) => i.table === jobs && i.values?.job_type === "BUILD");

describe("enqueueBuildAfterProvision", () => {
	it("enqueues a BUILD (reusing the snapshot) for an unbuilt repo-sourced service", async () => {
		const h = mockDb([[DEPLOY], [ACTIVE], [repoUnbuilt, repoBuilt]]);
		const res = await enqueueBuildAfterProvision("job-1");
		const b = buildInserts(h);
		expect(b).toHaveLength(1);
		expect(b[0].values?.status).toBe("QUEUED");
		expect(b[0].values?.config_snapshot).toEqual({ services: [{ name: "api" }] });
		expect(res).toEqual({ buildJobId: "build-1" });
	});

	it("no-ops when every repo service is already built (the loop guard)", async () => {
		const h = mockDb([[DEPLOY], [ACTIVE], [repoBuilt]]);
		await enqueueBuildAfterProvision("job-1");
		expect(buildInserts(h)).toHaveLength(0);
	});

	it("no-ops when no service is repo-sourced", async () => {
		const h = mockDb([[DEPLOY], [ACTIVE], [prebuilt]]);
		await enqueueBuildAfterProvision("job-1");
		expect(buildInserts(h)).toHaveLength(0);
	});

	it("no-ops when the env is not ACTIVE (a build needs the cluster)", async () => {
		const h = mockDb([[DEPLOY], [{ status: "FAILED" }]]);
		await enqueueBuildAfterProvision("job-1");
		expect(buildInserts(h)).toHaveLength(0);
	});

	it("no-ops for a non-DEPLOY job", async () => {
		const h = mockDb([[{ ...DEPLOY, job_type: "BUILD" }]]);
		await enqueueBuildAfterProvision("job-1");
		expect(buildInserts(h)).toHaveLength(0);
	});

	it("does NOT insert an orphan BUILD when the env CAS loses the race", async () => {
		const h = mockDb([[DEPLOY], [ACTIVE], [repoUnbuilt]], { casUpdated: false });
		await enqueueBuildAfterProvision("job-1");
		expect(buildInserts(h)).toHaveLength(0);
	});
});
