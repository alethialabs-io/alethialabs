// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The console list paging codec (lib/queries/keyset.ts, #7482). What is locked here:
//   - a cursor round-trips, and is opaque (not the ISO string in the clear);
//   - the instant is truncated to MILLISECONDS when the cursor is minted, so a microsecond value
//     and its millisecond cannot sit on different sides of a boundary;
//   - a tie on the sort key falls to the id, so a walk visits every row exactly once;
//   - a malformed cursor is REFUSED (the schema fails, which oRPC answers 400) — never page one;
//   - `limit` defaults to 50 and is refused above 100, not clamped;
//   - the SQL order and the cursor predicate read the same ms-truncated expression, as one
//     row-value comparison (rendered through the real PgDialect, not inferred from spies).

import { sql } from "drizzle-orm";
import { PgDialect, pgTable, timestamp, uuid as uuidColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
	decodeKeysetCursor,
	encodeKeysetCursor,
	KEYSET_DEFAULT_LIMIT,
	KEYSET_MAX_LIMIT,
	keysetAfter,
	keysetCursorSchema,
	keysetFetchLimit,
	keysetListPage,
	keysetOrderBy,
	keysetPage,
	keysetPageInMemory,
	keysetPageInput,
	keysetSortKey,
	type KeysetPosition,
} from "@/lib/queries/keyset";

/** A uuid whose trailing digits are `n`, so ids sort predictably. */
function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** Base64url of a string, for hand-building cursors the codec must refuse. */
function b64(text: string): string {
	return Buffer.from(text, "utf8").toString("base64url");
}

describe("encodeKeysetCursor / decodeKeysetCursor", () => {
	it("round-trips a position, and the cursor is opaque", () => {
		const cursor = encodeKeysetCursor({ at: new Date("2026-11-20T10:00:00.123Z"), id: uuid(7) });
		expect(cursor).not.toContain("2026");
		expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(decodeKeysetCursor(cursor)).toEqual({ at: "2026-11-20T10:00:00.123Z", id: uuid(7) });
	});

	it("truncates the instant to milliseconds when minting", () => {
		// Postgres hands back microseconds as a string in some drivers; the cursor must carry the ms.
		const fromMicros = encodeKeysetCursor({ at: "2026-11-20T10:00:00.123987Z", id: uuid(1) });
		expect(decodeKeysetCursor(fromMicros)?.at).toBe("2026-11-20T10:00:00.123Z");
	});

	it("carries integer and text ids when told the kind", () => {
		const n = encodeKeysetCursor({ at: "2026-11-20T10:00:00.000Z", id: 42 });
		expect(decodeKeysetCursor(n, "integer")).toEqual({ at: "2026-11-20T10:00:00.000Z", id: "42" });
		expect(decodeKeysetCursor(n, "uuid")).toBeNull();
		const t = encodeKeysetCursor({ at: "2026-11-20T10:00:00.000Z", id: "billing" });
		expect(decodeKeysetCursor(t, "text")?.id).toBe("billing");
	});

	it.each([
		["empty", ""],
		["not base64url", "not a cursor!"],
		["not JSON", b64("{oops")],
		["wrong version", b64(JSON.stringify(["v0", "2026-11-20T10:00:00.000Z", uuid(1)]))],
		["wrong arity", b64(JSON.stringify(["v1", "2026-11-20T10:00:00.000Z"]))],
		["an object, not a tuple", b64(JSON.stringify({ at: "2026-11-20T10:00:00.000Z", id: uuid(1) }))],
		["seconds precision", b64(JSON.stringify(["v1", "2026-11-20T10:00:00Z", uuid(1)]))],
		["microsecond precision", b64(JSON.stringify(["v1", "2026-11-20T10:00:00.000001Z", uuid(1)]))],
		["an impossible day (Date would roll it to March)", b64(JSON.stringify(["v1", "2026-02-30T10:00:00.000Z", uuid(1)]))],
		["an id that is not a uuid", b64(JSON.stringify(["v1", "2026-11-20T10:00:00.000Z", "1; drop table"]))],
		["too long", "A".repeat(600)],
	])("refuses a malformed cursor: %s", (_what, raw) => {
		expect(decodeKeysetCursor(raw)).toBeNull();
	});
});

describe("the input schema", () => {
	const input = z.object({ search: z.string().optional(), ...keysetPageInput() });

	it("decodes the cursor at the boundary, so the handler sees a position", () => {
		const cursor = encodeKeysetCursor({ at: "2026-11-20T10:00:00.123Z", id: uuid(3) });
		expect(input.parse({ cursor })).toEqual({ cursor: { at: "2026-11-20T10:00:00.123Z", id: uuid(3) }, limit: KEYSET_DEFAULT_LIMIT });
	});

	it("a malformed cursor FAILS validation (oRPC: 400), it does not read as page one", () => {
		const parsed = input.safeParse({ cursor: "garbage" });
		expect(parsed.success).toBe(false);
		expect(keysetCursorSchema().safeParse(b64("[]")).success).toBe(false);
	});

	it("limit defaults to 50 and is refused above 100 — never clamped", () => {
		expect(KEYSET_DEFAULT_LIMIT).toBe(50);
		expect(KEYSET_MAX_LIMIT).toBe(100);
		expect(input.parse({}).limit).toBe(50);
		expect(input.parse({ limit: 100 }).limit).toBe(100);
		expect(input.safeParse({ limit: 101 }).success).toBe(false);
		expect(input.safeParse({ limit: 0 }).success).toBe(false);
		expect(input.safeParse({ limit: 2.5 }).success).toBe(false);
	});
});

describe("keysetPage", () => {
	const keyOf = (r: { id: string; at: string }) => r;

	it("reads limit + 1 and says null at the exact end — no wasted empty page", () => {
		expect(keysetFetchLimit(50)).toBe(51);
		const rows = [1, 2].map((n) => ({ id: uuid(n), at: "2026-11-20T10:00:00.000Z" }));
		expect(keysetPage(rows, 2, keyOf).nextCursor).toBeNull();
		expect(keysetPage(rows, 2, keyOf).rows).toHaveLength(2);
	});

	it("with a further row, trims to limit and mints the LAST KEPT row's cursor", () => {
		const rows = [3, 2, 1].map((n) => ({ id: uuid(n), at: "2026-11-20T10:00:00.000Z" }));
		const page = keysetPage(rows, 2, keyOf);
		expect(page.rows.map((r) => r.id)).toEqual([uuid(3), uuid(2)]);
		expect(page.nextCursor && decodeKeysetCursor(page.nextCursor)).toEqual({ at: "2026-11-20T10:00:00.000Z", id: uuid(2) });
	});
});

describe("keysetListPage", () => {
	it("carries facets and universeEmpty on the first page only", () => {
		const cut = { rows: [], nextCursor: null };
		expect(keysetListPage(cut, { facets: { kind: [] }, universeEmpty: true })).toEqual({
			rows: [],
			nextCursor: null,
			facets: { kind: [] },
			universeEmpty: true,
		});
		expect(keysetListPage(cut, null)).toEqual({ rows: [], nextCursor: null, facets: null, universeEmpty: null });
	});
});

describe("keysetPageInMemory (composed universes)", () => {
	interface Stored {
		id: string;
		/** Microseconds since epoch — finer than a JS Date, as Postgres stores it. */
		micros: number;
	}
	const base = Date.parse("2026-11-20T10:00:00.000Z") * 1000;
	const table: Stored[] = [
		// Five rows in ONE microsecond: every page boundary of size 2 lands inside the tie.
		...[10, 11, 12, 13, 14].map((n) => ({ id: uuid(n), micros: base + 5_000 })),
		// Same millisecond, different microseconds: a ms cursor cannot tell these apart.
		{ id: uuid(20), micros: base + 2_100 },
		{ id: uuid(21), micros: base + 2_900 },
		{ id: uuid(22), micros: base + 2_500 },
		{ id: uuid(30), micros: base - 1_000_000 },
	];
	// The row's instant as a microsecond ISO string, which the codec must truncate itself.
	const keyOf = (r: Stored) => {
		const ms = Math.floor(r.micros / 1000);
		const micro = String(r.micros % 1000).padStart(3, "0");
		return { at: new Date(ms).toISOString().replace("Z", `${micro}Z`), id: r.id };
	};

	it("walks every row exactly once across boundaries inside sort-key ties, newest first, id breaking ties", () => {
		const seen: string[] = [];
		let cursor: KeysetPosition | undefined;
		for (let guard = 0; guard < 20; guard++) {
			const page = keysetPageInMemory(table, { cursor, limit: 2 }, keyOf);
			seen.push(...page.rows.map((r) => r.id));
			if (page.nextCursor === null) break;
			cursor = decodeKeysetCursor(page.nextCursor) ?? undefined;
		}
		expect(seen).toEqual([uuid(14), uuid(13), uuid(12), uuid(11), uuid(10), uuid(22), uuid(21), uuid(20), uuid(30)]);
	});

	it("orders integer ids numerically, not as strings", () => {
		const rows = [9, 10, 100].map((id) => ({ id, at: "2026-11-20T10:00:00.000Z" }));
		const page = keysetPageInMemory(rows, { limit: 3 }, (r) => r, "integer");
		expect(page.rows.map((r) => r.id)).toEqual([100, 10, 9]);
	});
});

describe("the SQL half", () => {
	const dialect = new PgDialect();
	const things = pgTable("things", { id: uuidColumn("id").primaryKey(), updated_at: timestamp("updated_at", { withTimezone: true }) });

	it("orders and compares on the SAME ms-truncated key, as one row-value comparison", () => {
		const key = keysetSortKey(things.updated_at);
		const order = dialect.sqlToQuery(sql.join(keysetOrderBy(key, things.id), sql`, `)).sql;
		expect(order).toBe(`date_trunc('milliseconds', "things"."updated_at") desc, "things"."id" desc`);
		const after = keysetAfter(key, things.id, { at: "2026-11-20T10:00:00.123Z", id: uuid(1) });
		if (after === undefined) throw new Error("expected a predicate");
		const rendered = dialect.sqlToQuery(after);
		expect(rendered.sql).toBe(`(date_trunc('milliseconds', "things"."updated_at"), "things"."id") < ($1::timestamptz, $2::uuid)`);
		expect(rendered.params).toEqual(["2026-11-20T10:00:00.123Z", uuid(1)]);
	});

	it("page one has no predicate, and the id cast follows the id kind", () => {
		const key = keysetSortKey(things.updated_at);
		expect(keysetAfter(key, things.id, undefined)).toBeUndefined();
		const after = keysetAfter(key, things.id, { at: "2026-11-20T10:00:00.123Z", id: "5" }, "integer");
		if (after === undefined) throw new Error("expected a predicate");
		expect(dialect.sqlToQuery(after).sql).toContain("$2::bigint)");
	});
});
