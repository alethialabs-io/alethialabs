// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The environment's job history pages on a keyset cursor. What matters: a page never returns the
// probe row it fetched to learn whether another page exists, the cursor it hands back names the
// last row it DID return, a malformed cursor reads as the first page, and every page stays inside
// the environment (the where clause carries project, environment and org).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(async () => ({ orgId: "org-1", userId: "u1" })),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn(), withActorScope: vi.fn() }));
vi.mock("@/lib/billing/job-quota", () => ({ assertJobQuotaAllowed: vi.fn() }));
vi.mock("@/lib/db/signed-job", () => ({ signedJob: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

import { getEnvironmentJobs } from "@/app/server/actions/canvas-jobs";
import { getServiceDb } from "@/lib/db";

interface Row {
	id: string;
	job_type: string;
	status: string;
	created_at: Date;
	error_message: string | null;
}

/**
 * A drizzle-ish chain. The action runs TWO queries — the env-in-org guard (which must find one
 * row) and then the jobs page — so each `select()` starts a fresh chain that resolves to the next
 * entry of `results`. Records the jobs query's limit.
 */
function mockDb(rows: Row[]) {
	const calls: { limit?: number } = {};
	// Odd selects are the env guard, even ones the jobs page — so a test may call the action twice.
	let selects = 0;
	const chain = () => {
		const own: unknown = selects++ % 2 === 0 ? [{ id: "e1" }] : rows;
		const db: Record<string, unknown> = {};
		Object.assign(db, {
			from: () => db,
			innerJoin: () => db,
			where: () => db,
			orderBy: () => db,
			limit: (n: number) => {
				if (own === rows) calls.limit = n;
				return db;
			},
			then: (resolve: (v: unknown) => void) => resolve(own),
		});
		return db;
	};
	vi.mocked(getServiceDb).mockReturnValue({ select: () => chain() } as never);
	return calls;
}

function row(i: number): Row {
	return {
		id: `job-${i}`,
		job_type: "DEPLOY",
		status: "SUCCESS",
		created_at: new Date(Date.UTC(2026, 8, 7, 12, 0, 60 - i)),
		error_message: null,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("getEnvironmentJobs", () => {
	it("fetches one row past the limit and returns a cursor only when it came back", async () => {
		const rows = Array.from({ length: 4 }, (_, i) => row(i + 1));
		const calls = mockDb(rows);
		const page = await getEnvironmentJobs("p1", "e1", { limit: 3 });
		expect(calls.limit).toBe(4);
		expect(page.jobs.map((j) => j.id)).toEqual(["job-1", "job-2", "job-3"]);
		expect(page.nextCursor).toBe(`${rows[2].created_at.toISOString()}|job-3`);
		expect(page.jobs[0]).toEqual({
			id: "job-1",
			type: "DEPLOY",
			status: "SUCCESS",
			createdAt: rows[0].created_at.toISOString(),
			error: null,
		});
	});

	it("the last page carries no cursor", async () => {
		mockDb([row(1), row(2)]);
		const page = await getEnvironmentJobs("p1", "e1", { limit: 3 });
		expect(page.jobs).toHaveLength(2);
		expect(page.nextCursor).toBeNull();
	});

	it("an empty environment is an empty page, not an error", async () => {
		mockDb([]);
		const page = await getEnvironmentJobs("p1", "e1");
		expect(page).toEqual({ jobs: [], nextCursor: null });
	});

	it("a malformed cursor reads as the first page rather than throwing", async () => {
		mockDb([row(1)]);
		await expect(
			getEnvironmentJobs("p1", "e1", { before: "garbage" }),
		).resolves.toMatchObject({ nextCursor: null });
		await expect(
			getEnvironmentJobs("p1", "e1", { before: "not-a-date|job-9" }),
		).resolves.toMatchObject({ nextCursor: null });
	});

	it("clamps the page size to a sane window", async () => {
		const calls = mockDb([]);
		await getEnvironmentJobs("p1", "e1", { limit: 10_000 });
		expect(calls.limit).toBe(101);
		await getEnvironmentJobs("p1", "e1", { limit: 0 });
		expect(calls.limit).toBe(2);
	});
});
