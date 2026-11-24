// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The environment's job history pages on the console's one keyset contract (LST-10 #7492). What
// matters: a page never returns the probe row it fetched to learn whether another page exists, the
// cursor it hands back names the last row it DID return (in the shared codec), a malformed cursor
// is REFUSED at the input (a 400 — it used to read as the first page, which re-shows rows), and
// every page stays inside the environment (the where clause carries project, environment and org).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(async () => ({ orgId: "org-1", userId: "u1" })),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn(), withActorScope: vi.fn() }));
vi.mock("@/lib/billing/job-quota", () => ({ assertJobQuotaAllowed: vi.fn() }));
vi.mock("@/lib/db/signed-job", () => ({ signedJob: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

import { canvasRouter, readEnvironmentJobs as getEnvironmentJobs } from "@/lib/rpc/procedures/canvas";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/lib/queries/keyset";
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

/** A uuid whose trailing digits are `n` — the cursor codec checks the id's kind. */
function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** Validates `input` against the `canvas.environmentJobs` procedure's own input schema. */
async function validInput(input: unknown): Promise<boolean> {
	const schema = canvasRouter.environmentJobs["~orpc"].inputSchema;
	if (schema === undefined) throw new Error("environmentJobs has no input schema");
	const result = await schema["~standard"].validate(input);
	return result.issues === undefined;
}

function row(i: number): Row {
	return {
		id: uuid(i),
		job_type: "DEPLOY",
		status: "SUCCESS",
		created_at: new Date(Date.UTC(2026, 8, 7, 12, 0, 60 - i)),
		error_message: null,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("readEnvironmentJobs (canvas.environmentJobs)", () => {
	it("fetches one row past the limit and returns a cursor only when it came back", async () => {
		const rows = Array.from({ length: 4 }, (_, i) => row(i + 1));
		const calls = mockDb(rows);
		const page = await getEnvironmentJobs("p1", "e1", { limit: 3 });
		expect(calls.limit).toBe(4);
		expect(page.rows.map((j) => j.id)).toEqual([uuid(1), uuid(2), uuid(3)]);
		expect(page.nextCursor).toBe(encodeKeysetCursor({ at: rows[2].created_at, id: uuid(3) }));
		expect(decodeKeysetCursor(page.nextCursor ?? "")).toEqual({ at: rows[2].created_at.toISOString(), id: uuid(3) });
		expect(page.rows[0]).toEqual({
			id: uuid(1),
			type: "DEPLOY",
			status: "SUCCESS",
			createdAt: rows[0].created_at.toISOString(),
			error: null,
		});
	});

	it("the last page carries no cursor", async () => {
		mockDb([row(1), row(2)]);
		const page = await getEnvironmentJobs("p1", "e1", { limit: 3 });
		expect(page.rows).toHaveLength(2);
		expect(page.nextCursor).toBeNull();
	});

	it("an empty environment is an empty page, not an error", async () => {
		mockDb([]);
		const page = await getEnvironmentJobs("p1", "e1");
		expect(page).toEqual({ rows: [], nextCursor: null, facets: null, universeEmpty: true });
	});

	it("a later page says nothing about the universe (null), and the first page says it is not empty", async () => {
		mockDb([row(1)]);
		const first = await getEnvironmentJobs("p1", "e1", { limit: 3 });
		expect(first.universeEmpty).toBe(false);
		const later = await getEnvironmentJobs("p1", "e1", {
			limit: 3,
			cursor: { at: "2026-09-07T12:00:59.000Z", id: uuid(9) },
		});
		expect(later.universeEmpty).toBeNull();
		expect(later.facets).toBeNull();
	});

	it("a malformed cursor is refused at the input — never read as the first page", async () => {
		const scope = { projectId: uuid(100), environmentId: uuid(101) };
		expect(await validInput(scope)).toBe(true);
		expect(await validInput({ ...scope, cursor: encodeKeysetCursor({ at: new Date(), id: uuid(1) }) })).toBe(true);
		expect(await validInput({ ...scope, cursor: "garbage" })).toBe(false);
		// The old `created_at|id` shape is not a cursor any more.
		expect(await validInput({ ...scope, cursor: "2026-09-07T12:00:00.000Z|job-9" })).toBe(false);
		// A cursor whose id is not a uuid would reach Postgres and raise; it is refused here instead.
		expect(await validInput({ ...scope, cursor: encodeKeysetCursor({ at: new Date(), id: "job-9" }) })).toBe(false);
	});

	it("refuses a page size outside 1–100 rather than clamping it", async () => {
		const scope = { projectId: uuid(100), environmentId: uuid(101) };
		expect(await validInput({ ...scope, limit: 100 })).toBe(true);
		expect(await validInput({ ...scope, limit: 101 })).toBe(false);
		expect(await validInput({ ...scope, limit: 0 })).toBe(false);
	});

	it("refuses an environment outside the actor's org as NOT_FOUND — a typed refusal, not an empty history", async () => {
		// The env guard finds nothing: every select resolves to no rows.
		mockDb([]);
		vi.mocked(getServiceDb).mockReturnValue(
			// @ts-expect-error a chain stub with only the methods the guard calls, not a full drizzle db
			{ select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ limit: async () => [] }) }) }) }) },
		);
		await expect(getEnvironmentJobs("p1", "e-foreign")).rejects.toMatchObject({
			name: "ActionRefusal",
			kind: "not-found",
		});
	});
});
