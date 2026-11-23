// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Query-builder tests for the support-case visibility filters. Drives a thenable drizzle-ish tx
// stub (each await shifts the next seeded result set) and spies on the real drizzle `inArray`/`eq`
// helpers to assert: listCasesForOwner buckets by the right status set (active vs resolved vs
// none), and getCaseWithThread strips is_internal staff notes and returns null for a missing case.

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
import {
	type CaseCursor,
	getCaseWithThread,
	listCasesForOwner,
	nextCaseCursor,
} from "@/lib/queries/support";
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

// ── Keyset paging (#7389) ───────────────────────────────────────────────────────────────────────
//
// No Postgres here, so the boundary is proven in two halves that meet at the rendered SQL:
//   1. the builder's ORDER BY and cursor predicate are the SAME (ms-truncated activity, id) key, as
//      one row-value comparison (rendered through the real PgDialect, not inferred from spies);
//   2. a walk over a fixture full of timestamp ties — evaluated with Postgres's row-comparison and
//      date_trunc semantics on the PARAMETERS the builder rendered — visits every case exactly once,
//      with the next cursor taken from each page by the real `nextCaseCursor`.

const dialect = new PgDialect();

/** A case as Postgres holds it: activity in MICROseconds since epoch (finer than a JS Date). */
interface StoredCase {
	id: string;
	micros: number;
}

/** A tx stub that answers listCasesForOwner like Postgres would over `table`. */
function keysetTx(table: StoredCase[]) {
	const sqls: { where: string; params: unknown[]; orderBy: string }[] = [];
	let where: SQL | undefined;
	let orderBy: SQL[] = [];
	let limit = Number.POSITIVE_INFINITY;
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
		then: (resolve: (v: unknown) => void) => {
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

describe("listCasesForOwner keyset paging", () => {
	it("orders and compares on the same (ms-truncated activity, id) key, as one row comparison", async () => {
		const { tx, sqls } = keysetTx([]);
		const cursor: CaseCursor = { at: "2026-11-20T10:00:00.123Z", id: uuid(1) };
		await listCasesForOwner(tx, "owner-1", {}, { cursor, limit: 2 });
		const [q] = sqls;
		expect(q.orderBy).toBe(
			`date_trunc('milliseconds', "support_cases"."last_message_at") desc, "support_cases"."id" desc`,
		);
		expect(q.where).toContain(
			`(date_trunc('milliseconds', "support_cases"."last_message_at"), "support_cases"."id") < ($`,
		);
		expect(q.params.slice(-2)).toEqual([cursor.at, cursor.id]);
	});

	it("no page request reads every case: no cursor predicate, no limit", async () => {
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
		let cursor: CaseCursor | undefined;
		for (let guard = 0; guard < 20; guard++) {
			const page = await listCasesForOwner(tx, "owner-1", {}, { cursor, limit: 2 });
			seen.push(...page.map((r) => r.id));
			const next = nextCaseCursor(page, 2);
			if (next === null) break;
			cursor = next;
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

describe("nextCaseCursor", () => {
	it("is null for a short page — the end — and the last row's key for a full one", () => {
		const at = new Date("2026-11-20T10:00:00.123Z");
		expect(nextCaseCursor([], 2)).toBeNull();
		expect(nextCaseCursor([{ id: uuid(1), last_message_at: at }], 2)).toBeNull();
		expect(
			nextCaseCursor(
				[
					{ id: uuid(2), last_message_at: at },
					{ id: uuid(1), last_message_at: at },
				],
				2,
			),
		).toEqual({ at: "2026-11-20T10:00:00.123Z", id: uuid(1) });
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
