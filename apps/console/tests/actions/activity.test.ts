// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the Activity action: stub currentActor + entitlements + a thenable
// drizzle chain, and spy the drizzle operators (kept otherwise real) so we can assert the
// cursor `limit+1` pagination math and that each filter adds the expected WHERE condition.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ currentActor: vi.fn() }));
vi.mock("@/lib/authz/entitlements", () => ({ getEntitlements: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

// Keep drizzle real, but spy the operators the action builds its WHERE from.
vi.mock("drizzle-orm", async (importOriginal) => {
	const actual = await importOriginal<typeof import("drizzle-orm")>();
	return {
		...actual,
		eq: vi.fn(actual.eq),
		lt: vi.fn(actual.lt),
		gte: vi.fn(actual.gte),
		lte: vi.fn(actual.lte),
		inArray: vi.fn(actual.inArray),
		ilike: vi.fn(actual.ilike),
		or: vi.fn(actual.or),
		and: vi.fn(actual.and),
	};
});

import { eq, gte, ilike, inArray, lt, lte, or } from "drizzle-orm";
import { getActivityExportCsv, getActivityLog } from "@/app/server/actions/activity";
import { getEntitlements } from "@/lib/authz/entitlements";
import { currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";

interface DbRow {
	id: number;
	actorId: string;
	actorName: string | null;
	actorEmail: string | null;
	actorImage: string | null;
	actorUsername: string | null;
	action: string;
	resourceType: string;
	resourceId: string | null;
	decision: boolean;
	reason: string | null;
	ts: Date;
}

/** A drizzle-ish chain that resolves to `rows` and records the limit it was asked for. */
function mockDb(rows: DbRow[]) {
	const calls: { limit?: number } = {};
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		leftJoin: () => db,
		where: () => db,
		orderBy: () => db,
		limit: (n: number) => {
			calls.limit = n;
			return db;
		},
		then: (resolve: (v: unknown) => void) => resolve(rows),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return calls;
}

function dbRow(over: Partial<DbRow> = {}): DbRow {
	return {
		id: 1,
		actorId: "u-1",
		actorName: "Boris",
		actorEmail: "boris@x.io",
		actorImage: null,
		actorUsername: null,
		action: "create",
		resourceType: "project",
		resourceId: "project-1",
		decision: true,
		reason: null,
		ts: new Date("2026-06-20T10:00:00.000Z"),
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(currentActor).mockResolvedValue({ orgId: "org-1" } as never);
});

describe("getActivityLog — pagination", () => {
	it("returns no cursor when the page isn't full and stringifies ids + ISO timestamps", async () => {
		mockDb([dbRow({ id: 2 }), dbRow({ id: 1 })]);
		const page = await getActivityLog();
		expect(page.nextCursor).toBeNull();
		expect(page.rows).toHaveLength(2);
		expect(page.rows[0]).toMatchObject({ id: "2", ts: "2026-06-20T10:00:00.000Z" });
	});

	it("fetches limit+1 and derives the next cursor from the last kept row", async () => {
		// limit 2 → fetch 3; the extra row signals a further page.
		const calls = mockDb([dbRow({ id: 5 }), dbRow({ id: 4 }), dbRow({ id: 3 })]);
		const page = await getActivityLog({ limit: 2 });
		expect(calls.limit).toBe(3);
		expect(page.rows.map((r) => r.id)).toEqual(["5", "4"]);
		expect(page.nextCursor).toBe(4);
	});

	it("applies the cursor as a strict id upper bound", async () => {
		mockDb([dbRow()]);
		await getActivityLog({ cursor: 10 });
		expect(vi.mocked(lt)).toHaveBeenCalled();
	});

	it("always scopes by org and defaults the page size to 50 (+1)", async () => {
		const calls = mockDb([dbRow()]);
		await getActivityLog();
		expect(vi.mocked(eq)).toHaveBeenCalled(); // org scope
		expect(calls.limit).toBe(51);
		expect(vi.mocked(lt)).not.toHaveBeenCalled(); // no cursor
	});
});

describe("getActivityLog — filters", () => {
	it("adds IN conditions for actor / resource-type / resource-id filters", async () => {
		mockDb([dbRow()]);
		await getActivityLog({
			actorIds: ["u-1"],
			resourceTypes: ["project"],
			resourceIds: ["z-1"],
		});
		expect(vi.mocked(inArray)).toHaveBeenCalledTimes(3);
	});

	it("adds a date range when from/to are given", async () => {
		mockDb([dbRow()]);
		await getActivityLog({ from: "2026-06-01T00:00:00.000Z", to: "2026-06-30T00:00:00.000Z" });
		expect(vi.mocked(gte)).toHaveBeenCalled();
		expect(vi.mocked(lte)).toHaveBeenCalled();
	});

	it("adds an ILIKE OR-group for search", async () => {
		mockDb([dbRow()]);
		await getActivityLog({ search: "deploy" });
		expect(vi.mocked(ilike)).toHaveBeenCalled();
		expect(vi.mocked(or)).toHaveBeenCalled();
	});

	it("constrains the decision only when it is a boolean", async () => {
		// eq fires for the leftJoin + org scope regardless; a decision filter adds one more.
		mockDb([dbRow()]);
		await getActivityLog({ decision: null });
		const baseline = vi.mocked(eq).mock.calls.length;
		vi.mocked(eq).mockClear();

		mockDb([dbRow()]);
		await getActivityLog({ decision: false });
		expect(vi.mocked(eq).mock.calls.length).toBe(baseline + 1);
	});
});

describe("getActivityExportCsv", () => {
	it("rejects callers without the activityExport entitlement", async () => {
		vi.mocked(getEntitlements).mockReturnValue({ activityExport: false } as never);
		await expect(getActivityExportCsv()).rejects.toThrow(/Enterprise/);
	});

	it("emits a CSV with a header and one row per entry", async () => {
		vi.mocked(getEntitlements).mockReturnValue({ activityExport: true } as never);
		mockDb([dbRow({ id: 1, action: "deploy", decision: false, reason: "nope" })]);
		const csv = await getActivityExportCsv();
		const lines = csv.split("\n");
		expect(lines[0]).toContain("time,actor,action");
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain('"deploy"');
		expect(lines[1]).toContain('"deny"');
	});
});
