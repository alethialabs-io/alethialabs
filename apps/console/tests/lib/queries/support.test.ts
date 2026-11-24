// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Query-builder tests for the support-case visibility filters. Drives a thenable drizzle-ish tx
// stub (each await shifts the next seeded result set) and spies on the real drizzle `inArray`/`eq`
// helpers to assert: listCasesForOwner buckets by the right status set (active vs resolved vs
// none) and applies the search / severity / type filters in SQL, queryCasesPage adds an UNFILTERED
// facet pass on the first page only, and getCaseWithThread strips is_internal staff notes and
// returns null for a missing case.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Wrap the real drizzle helpers with spies so we can assert how the WHERE was composed
// without depending on the opaque SQL object identity.
vi.mock("drizzle-orm", async (importOriginal) => {
	const actual = await importOriginal<typeof import("drizzle-orm")>();
	return {
		...actual,
		inArray: vi.fn(actual.inArray),
		eq: vi.fn(actual.eq),
	};
});

import { eq, inArray, type SQL, sql as sqlTag } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { decodeKeysetCursor, type KeysetPosition } from "@/lib/queries/keyset";
import { getCaseWithThread, listCasesForOwner, queryCasesPage } from "@/lib/queries/support";
import { supportCases, supportMessages } from "@/lib/db/schema";

/** A thenable drizzle-ish tx: each await shifts the next seeded result set. */
function mockTx(resultSets: unknown[][]) {
	const whereSpy = vi.fn();
	const orderBySpy = vi.fn();
	let i = 0;
	const tx: Record<string, unknown> = {};
	Object.assign(tx, {
		select: () => tx,
		from: () => tx,
		leftJoin: () => tx,
		where: (...a: unknown[]) => {
			whereSpy(...a);
			return tx;
		},
		limit: () => tx,
		groupBy: () => tx,
		orderBy: (...a: unknown[]) => {
			orderBySpy(...a);
			return tx;
		},
		then: (resolve: (v: unknown) => void) => {
			const r = i < resultSets.length ? resultSets[i] : (resultSets.at(-1) ?? []);
			i++;
			return resolve(r);
		},
	});
	return { tx: tx as never, whereSpy, orderBySpy };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("listCasesForOwner", () => {
	it("filters by the ACTIVE status set for { status: \"active\" }", async () => {
		const { tx, whereSpy, orderBySpy } = mockTx([[{ id: "c-1" }]]);
		const rows = await listCasesForOwner(tx, "owner-1", { status: "active" });
		expect(rows).toHaveLength(1);
		expect(inArray).toHaveBeenCalledWith(supportCases.status, [
			"open",
			"pending_support",
			"pending_customer",
		]);
		expect(whereSpy).toHaveBeenCalledTimes(1);
		expect(orderBySpy).toHaveBeenCalledTimes(1);
	});

	it("filters by the RESOLVED status set for { status: \"resolved\" }", async () => {
		const { tx } = mockTx([[]]);
		await listCasesForOwner(tx, "owner-1", { status: "resolved" });
		expect(inArray).toHaveBeenCalledWith(supportCases.status, ["resolved", "closed"]);
	});

	it("applies no status filter when none is given (where called with undefined)", async () => {
		const { tx, whereSpy } = mockTx([[]]);
		await listCasesForOwner(tx, "owner-1");
		expect(inArray).not.toHaveBeenCalled();
		expect(whereSpy).toHaveBeenCalledWith(undefined);
	});
});

// ── The filter bar, in SQL (#7396) ───────────────────────────────────────────────────────────────

const filterDialect = new PgDialect();

/** The rendered WHERE of the one rows pass `run` issued against a fresh stub. */
async function renderedWhere(run: (tx: never) => Promise<unknown>) {
	const { tx, whereSpy } = mockTx([[]]);
	await run(tx);
	const w: SQL | undefined = whereSpy.mock.calls[0]?.[0];
	return w ? filterDialect.sqlToQuery(w) : { sql: "", params: [] };
}

describe("listCasesForOwner filters", () => {
	it("searches the subject, the CASE-000123 reference and the bare number, LIKE-escaped", async () => {
		const q = await renderedWhere((tx) => listCasesForOwner(tx, "owner-1", { search: "  50%_off  " }));
		expect(q.sql).toContain(`"support_cases"."subject" ilike $1`);
		expect(q.sql).toContain(`('CASE-' || repeat('0', greatest(0, 6 - length("support_cases"."case_number"::text)))`);
		expect(q.sql).toContain(`"support_cases"."case_number"::text ilike $3`);
		// Trimmed, and the wildcards match literally.
		expect(q.params).toEqual(["%50\\%\\_off%", "%50\\%\\_off%", "%50\\%\\_off%"]);
	});

	it("narrows severity and type to the enum, dropping a stale link's unknown value", async () => {
		await listCasesForOwner(mockTx([[]]).tx, "owner-1", {
			severity: ["urgent", "bogus"],
			type: ["billing"],
		});
		expect(inArray).toHaveBeenCalledWith(supportCases.severity, ["urgent"]);
		expect(inArray).toHaveBeenCalledWith(supportCases.type, ["billing"]);
	});

	it("an all-unknown facet selection is no predicate at all, never `in ()`", async () => {
		const q = await renderedWhere((tx) => listCasesForOwner(tx, "owner-1", { severity: ["bogus"] }));
		expect(q.sql).toBe("");
	});

	it("combines the bucket with the filters", async () => {
		const q = await renderedWhere((tx) =>
			listCasesForOwner(tx, "owner-1", { status: "resolved", severity: ["high"], search: "vpn" }),
		);
		expect(q.params).toEqual(["resolved", "closed", "high", "%vpn%", "%vpn%", "%vpn%"]);
	});
});

describe("queryCasesPage", () => {
	const facetGroups = [
		{ severity: "normal", type: "technical", n: 2 },
		{ severity: "urgent", type: "technical", n: 1 },
		{ severity: "normal", type: "billing", n: 4 },
	];

	it("adds an UNFILTERED facet pass on the first page, counted per dimension", async () => {
		const { tx, whereSpy } = mockTx([[{ id: "c-1" }], facetGroups]);
		const page = await queryCasesPage(tx, "owner-1", { severity: ["urgent"], search: "vpn" }, { limit: 50 });
		expect(page.rows).toEqual([{ id: "c-1" }]);
		expect(page.facets).toEqual({
			severity: [
				{ value: "normal", label: null, count: 6 },
				{ value: "urgent", label: null, count: 1 },
			],
			type: [
				{ value: "technical", label: null, count: 3 },
				{ value: "billing", label: null, count: 4 },
			],
		});
		// Some case is in scope, so an empty `rows` would be the FILTERED empty.
		expect(page.universeEmpty).toBe(false);
		expect(page.nextCursor).toBeNull();
		// Only the rows pass took a WHERE: the facet pass sees the RLS scope and nothing else.
		expect(whereSpy).toHaveBeenCalledTimes(1);
	});

	it("an empty facet pass is an empty universe — the first-run empty, not a filtered one", async () => {
		const { tx } = mockTx([[], []]);
		const page = await queryCasesPage(tx, "owner-1", { search: "vpn" }, { limit: 50 });
		expect(page).toEqual({ rows: [], nextCursor: null, facets: { severity: [], type: [] }, universeEmpty: true });
	});

	it("a later page carries no facets and issues no facet pass", async () => {
		const { tx } = mockTx([[{ id: "c-2" }], facetGroups]);
		const page = await queryCasesPage(tx, "owner-1", {}, {
			limit: 50,
			cursor: { at: "2026-11-20T10:00:00.123Z", id: "c-1" },
		});
		expect(page).toEqual({ rows: [{ id: "c-2" }], nextCursor: null, facets: null, universeEmpty: null });
	});
});

// ── Keyset paging (#7389) ───────────────────────────────────────────────────────────────────────
//
// No Postgres here, so the boundary is proven in two halves that meet at the rendered SQL:
//   1. the builder's ORDER BY and cursor predicate are the SAME (ms-truncated activity, id) key, as
//      one row-value comparison (rendered through the real PgDialect, not inferred from spies);
//   2. a walk over a fixture full of timestamp ties — evaluated with Postgres's row-comparison and
//      date_trunc semantics on the PARAMETERS the builder rendered — visits every case exactly once,
//      following each page's opaque `nextCursor` (minted by the shared codec, lib/queries/keyset.ts).

const dialect = new PgDialect();

/** A case as Postgres holds it: activity in MICROseconds since epoch (finer than a JS Date). */
interface StoredCase {
	id: string;
	micros: number;
}

/** A tx stub that answers the cases rows pass like Postgres would over `table` (and the facet pass with nothing). */
function keysetTx(table: StoredCase[]) {
	const sqls: { where: string; params: unknown[]; orderBy: string }[] = [];
	let where: SQL | undefined;
	let orderBy: SQL[] = [];
	let limit = Number.POSITIVE_INFINITY;
	let grouped = false;
	const truncMs = (c: StoredCase) => Math.floor(c.micros / 1000);
	const tx: Record<string, unknown> = {};
	Object.assign(tx, {
		select: () => tx,
		from: () => tx,
		leftJoin: () => tx,
		where: (w: SQL | undefined) => {
			where = w;
			return tx;
		},
		orderBy: (...o: SQL[]) => {
			orderBy = o;
			return tx;
		},
		limit: (n: number) => {
			limit = n;
			return tx;
		},
		groupBy: () => {
			grouped = true;
			return tx;
		},
		then: (resolve: (v: unknown) => void) => {
			if (grouped) {
				grouped = false;
				return resolve([]);
			}
			const rendered = where ? dialect.sqlToQuery(where) : { sql: "", params: [] };
			const order = dialect.sqlToQuery(sqlJoin(orderBy)).sql;
			sqls.push({ where: rendered.sql, params: rendered.params, orderBy: order });
			// The cursor is the last two params the builder rendered: (at, id).
			const [at, id] = rendered.params.slice(-2);
			const cursorMs = typeof at === "string" ? Date.parse(at) : null;
			const rows = [...table]
				.sort((a, b) => truncMs(b) - truncMs(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
				.filter(
					(c) =>
						cursorMs === null ||
						typeof id !== "string" ||
						truncMs(c) < cursorMs ||
						(truncMs(c) === cursorMs && c.id < id),
				)
				.slice(0, limit)
				.map((c) => ({ id: c.id, last_message_at: new Date(truncMs(c)) }));
			limit = Number.POSITIVE_INFINITY;
			where = undefined;
			return resolve(rows);
		},
	});
	return { tx: tx as never, sqls };
}

/** Joins ORDER BY terms the way drizzle would render them, for inspection. */
function sqlJoin(terms: SQL[]): SQL {
	return terms.reduce<SQL | undefined>(
		(acc, t) => (acc ? sqlTag`${acc}, ${t}` : t),
		undefined,
	) ?? sqlTag``;
}

/** A uuid whose trailing digits are `n`, so ids sort predictably. */
function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

describe("queryCasesPage keyset paging", () => {
	it("orders and compares on the same (ms-truncated activity, id) key, as one row comparison", async () => {
		const { tx, sqls } = keysetTx([]);
		const cursor: KeysetPosition = { at: "2026-11-20T10:00:00.123Z", id: uuid(1) };
		await queryCasesPage(tx, "owner-1", {}, { cursor, limit: 2 });
		const [q] = sqls;
		expect(q.orderBy).toBe(
			`date_trunc('milliseconds', "support_cases"."last_message_at") desc, "support_cases"."id" desc`,
		);
		expect(q.where).toContain(
			`(date_trunc('milliseconds', "support_cases"."last_message_at"), "support_cases"."id") < ($`,
		);
		expect(q.params.slice(-2)).toEqual([cursor.at, cursor.id]);
	});

	it("the bell's unpaged read takes every case: no cursor predicate, no limit", async () => {
		const table = Array.from({ length: 7 }, (_, i) => ({ id: uuid(i), micros: 1_000_000 * i }));
		const { tx, sqls } = keysetTx(table);
		const rows = await listCasesForOwner(tx, "owner-1");
		expect(rows).toHaveLength(7);
		expect(sqls[0].where).toBe("");
	});

	it("walks every case exactly once across page boundaries that fall inside timestamp ties", async () => {
		const base = Date.parse("2026-11-20T10:00:00.000Z") * 1000;
		const table: StoredCase[] = [
			// Five cases in ONE microsecond: every page boundary of size 2 lands inside the tie.
			...[10, 11, 12, 13, 14].map((n) => ({ id: uuid(n), micros: base + 5_000 })),
			// Same millisecond, different microseconds: a JS-Date cursor cannot tell these apart.
			{ id: uuid(20), micros: base + 2_100 },
			{ id: uuid(21), micros: base + 2_900 },
			{ id: uuid(22), micros: base + 2_500 },
			// Distinct, older activity.
			{ id: uuid(30), micros: base - 1_000_000 },
		];
		const { tx } = keysetTx(table);

		const seen: string[] = [];
		let cursor: KeysetPosition | undefined;
		for (let guard = 0; guard < 20; guard++) {
			const page = await queryCasesPage(tx, "owner-1", {}, { cursor, limit: 2 });
			seen.push(...page.rows.map((r) => r.id));
			if (page.nextCursor === null) break;
			cursor = decodeKeysetCursor(page.nextCursor) ?? undefined;
			expect(cursor).toBeDefined();
		}

		expect(seen).toHaveLength(table.length);
		expect(new Set(seen).size).toBe(table.length);
		// Newest activity first; within a tie, id descending.
		expect(seen).toEqual([
			uuid(14), uuid(13), uuid(12), uuid(11), uuid(10),
			uuid(22), uuid(21), uuid(20),
			uuid(30),
		]);
	});
});

describe("queryCasesPage next cursor", () => {
	it("is exact: a last page of exactly `limit` rows says null, a page with more names its last row", async () => {
		const base = Date.parse("2026-11-20T10:00:00.123Z") * 1000;
		const table = [1, 2, 3, 4].map((n) => ({ id: uuid(n), micros: base + n }));

		const all = await queryCasesPage(keysetTx(table).tx, "owner-1", {}, { limit: 4 });
		expect(all.rows).toHaveLength(4);
		expect(all.nextCursor).toBeNull();

		const first = await queryCasesPage(keysetTx(table).tx, "owner-1", {}, { limit: 3 });
		expect(first.nextCursor).not.toBeNull();
		expect(decodeKeysetCursor(first.nextCursor ?? "")).toEqual({
			at: "2026-11-20T10:00:00.123Z",
			id: first.rows.at(-1)?.id,
		});
	});
});

describe("getCaseWithThread", () => {
	const caseId = "33333333-3333-4333-8333-333333333333";

	it("returns null when the case does not exist (no further queries)", async () => {
		const { tx, whereSpy } = mockTx([[]]);
		const result = await getCaseWithThread(tx, caseId);
		expect(result).toBeNull();
		// only the initial case select ran
		expect(whereSpy).toHaveBeenCalledTimes(1);
	});

	it("excludes is_internal staff notes and returns the case bundle", async () => {
		const caseRow = { id: caseId, subject: "S" };
		const messages = [{ id: "m-1", body: "hello" }];
		const attachments = [{ id: "a-1" }];
		const { tx } = mockTx([[caseRow], messages, attachments]);

		const result = await getCaseWithThread(tx, caseId);

		expect(result).not.toBeNull();
		expect(result?.case).toEqual(caseRow);
		expect(result?.messages).toEqual(messages);
		expect(result?.attachments).toEqual(attachments);

		// the message query filters is_internal = false
		const eqCalls = vi.mocked(eq).mock.calls;
		expect(
			eqCalls.some(
				(c) => c[0] === supportMessages.is_internal && c[1] === false,
			),
		).toBe(true);
	});
});
