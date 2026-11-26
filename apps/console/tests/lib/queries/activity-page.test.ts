// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `queryActivityPage` on the console's one keyset contract (LST-10 #7492). Its cursor used to be
// the bare bigint id (`id < n`) with its own number-typed input; it is now the shared codec's
// `(ts to the ms, id)`. What a mocked db CAN show, and so what is locked here:
//
//   · the ORDER BY and the cursor predicate read the same ms-truncated `ts` expression, the id
//     breaking ties, as one row-value comparison with a bigint cast (the boundary-inside-a-tie
//     proof is the codec's, tests/lib/queries/keyset.test.ts, and the walk over real Postgres is
//     tests/integration/activity-page.test.ts);
//   · the page reads `limit + 1` rows and mints the next cursor from the last row it RETURNED;
//   · `universeEmpty` answers on the first page from the facet passes — false while the scope
//     holds anything, true when it holds nothing — and is null on a later page;
//   · the procedure's input refuses a malformed cursor and a limit over 100 (a 400), never page one.

import { PgDialect } from "drizzle-orm/pg-core";
import { SQL, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockChainDb, type RecordedChain } from "./_list-query-db";

const { getServiceDb } = vi.hoisted(() => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb }));
vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn(async () => ({ orgId: "org-1" })), currentActor: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getPdp: vi.fn() }));
vi.mock("@/lib/authz/entitlements", () => ({ getEntitlements: vi.fn() }));

import { queryActivityPage } from "@/lib/queries/activity";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/lib/queries/keyset";
import { activityRouter } from "@/lib/rpc/procedures/activity";

const ORG = "org-1";
const dialect = new PgDialect();

/** A rows-pass row as the select returns it (bigint id as a number, `ts` as a Date). */
function dbRow(id: number, ts: string) {
	return {
		id,
		actorId: "u-1",
		actorName: "Ada",
		actorEmail: null,
		actorImage: null,
		actorUsername: null,
		action: "update",
		resourceType: "project",
		resourceId: null,
		resourceName: null,
		decision: true,
		reason: null,
		ts: new Date(ts),
	};
}

/** Seeds the first page's await order (actor, event, project facet rows, then the rows). */
function seedFirst(events: unknown[], rows: unknown[]) {
	const { db, chains } = mockChainDb([[], events, [], rows]);
	getServiceDb.mockReturnValue(db);
	return chains;
}

/** Seeds a later page: the rows pass is the only read. */
function seedLater(rows: unknown[]) {
	const { db, chains } = mockChainDb([rows]);
	getServiceDb.mockReturnValue(db);
	return chains;
}

/** The rows pass: the one chain that was ordered. */
function rowsPass(chains: RecordedChain[]): RecordedChain {
	const pass = chains.find((c) => c.called("orderBy"));
	if (!pass) throw new Error("no rows pass");
	return pass;
}

/** Renders a list of SQL fragments the way Postgres would receive them. */
function rendered(parts: unknown[] | undefined): string {
	const fragments = (parts ?? []).filter((p): p is SQL => p instanceof SQL);
	return dialect.sqlToQuery(sql.join(fragments, sql`, `)).sql;
}

/** The rows pass's WHERE, rendered. */
function whereOf(chain: RecordedChain): { sql: string; params: unknown[] } {
	const where = chain.argsOf("where")?.[0];
	if (!(where instanceof SQL)) throw new Error("the rows pass has no WHERE");
	return dialect.sqlToQuery(where);
}

/** Validates `input` against the `activity.page` procedure's own input schema. */
async function validInput(input: unknown): Promise<boolean> {
	const schema = activityRouter.page["~orpc"].inputSchema;
	if (schema === undefined) throw new Error("activity.page has no input schema");
	const result = await schema["~standard"].validate(input);
	return result.issues === undefined;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("queryActivityPage — the keyset order and cursor", () => {
	it("orders on ts truncated to the millisecond in the indexable UTC form, then the id, both descending", async () => {
		const chains = seedFirst([], []);
		await queryActivityPage(ORG);
		// The exact expression idx_authz_activity_org_ts_ms_id holds (#7539): another spelling of
		// the same order would read correctly and quietly sort in memory.
		expect(rendered(rowsPass(chains).argsOf("orderBy"))).toBe(
			`date_trunc('milliseconds', ("authz_activity_log"."ts" at time zone 'UTC')) desc, "authz_activity_log"."id" desc`,
		);
	});

	it("applies the cursor as one row-value predicate over the same expression, with a bigint cast", async () => {
		const chains = seedLater([]);
		await queryActivityPage(ORG, {}, { limit: 50, cursor: { at: "2026-06-20T10:00:00.123Z", id: "42" } });
		const query = whereOf(rowsPass(chains));
		expect(query.sql).toContain(
			`(date_trunc('milliseconds', ("authz_activity_log"."ts" at time zone 'UTC')), "authz_activity_log"."id") < (($`,
		);
		expect(query.sql).toMatch(/::timestamptz at time zone 'UTC'\), \$\d+::bigint\)/);
		expect(query.params).toEqual(expect.arrayContaining(["2026-06-20T10:00:00.123Z", "42"]));
	});

	it("page one carries no cursor predicate", async () => {
		const chains = seedFirst([], []);
		await queryActivityPage(ORG);
		expect(whereOf(rowsPass(chains)).sql).not.toContain("date_trunc");
	});

	it("reads limit + 1 and mints the cursor from the last row it returned, in the shared codec", async () => {
		const rows = [
			dbRow(9, "2026-06-20T10:00:03.000Z"),
			// A tie on the instant: the id decides, and the cursor names both halves.
			dbRow(8, "2026-06-20T10:00:02.000Z"),
			dbRow(7, "2026-06-20T10:00:02.000Z"),
		];
		const chains = seedLater(rows);
		const page = await queryActivityPage(ORG, {}, { limit: 2, cursor: { at: "2026-06-20T10:00:04.000Z", id: "10" } });
		expect(rowsPass(chains).argsOf("limit")).toEqual([3]);
		expect(page.rows.map((r) => r.id)).toEqual(["9", "8"]);
		expect(page.nextCursor).toBe(encodeKeysetCursor({ at: "2026-06-20T10:00:02.000Z", id: 8 }));
		expect(decodeKeysetCursor(page.nextCursor ?? "", "integer")).toEqual({ at: "2026-06-20T10:00:02.000Z", id: "8" });
	});

	it("the last page carries no cursor", async () => {
		seedLater([dbRow(1, "2026-06-20T10:00:00.000Z")]);
		const page = await queryActivityPage(ORG, {}, { limit: 2, cursor: { at: "2026-06-20T10:00:04.000Z", id: "10" } });
		expect(page.nextCursor).toBeNull();
	});
});

describe("queryActivityPage — universeEmpty", () => {
	it("is false on the first page while the scope holds anything, even when the window shows nothing", async () => {
		seedFirst([{ resourceType: "project", decision: false, count: 3 }], []);
		const page = await queryActivityPage(ORG);
		expect(page.rows).toEqual([]);
		expect(page.universeEmpty).toBe(false);
	});

	it("is true on the first page when the scope's log is empty", async () => {
		seedFirst([], []);
		expect((await queryActivityPage(ORG)).universeEmpty).toBe(true);
	});

	it("is null on a later page", async () => {
		seedLater([]);
		const page = await queryActivityPage(ORG, {}, { limit: 2, cursor: { at: "2026-06-20T10:00:04.000Z", id: "10" } });
		expect(page.universeEmpty).toBeNull();
		expect(page.facets).toBeNull();
	});
});

describe("activity.page input — the paging half", () => {
	it("takes the shared codec's cursor and refuses anything else as a 400", async () => {
		expect(await validInput({})).toBe(true);
		expect(await validInput({ cursor: encodeKeysetCursor({ at: new Date(), id: 42 }) })).toBe(true);
		// The old id-number cursor is not a cursor any more.
		expect(await validInput({ cursor: 42 })).toBe(false);
		expect(await validInput({ cursor: "garbage" })).toBe(false);
		// The activity log's id is a bigint: a uuid id would reach Postgres and raise.
		expect(
			await validInput({ cursor: encodeKeysetCursor({ at: new Date(), id: "00000000-0000-4000-8000-000000000001" }) }),
		).toBe(false);
	});

	it("refuses a page size over 100 rather than clamping it", async () => {
		expect(await validInput({ limit: 100 })).toBe(true);
		expect(await validInput({ limit: 101 })).toBe(false);
	});
});
