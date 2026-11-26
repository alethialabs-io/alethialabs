// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The codec's TEXT mode (lib/queries/keyset.ts, LST-8 #7490) — alphabetical lists. What is locked:
//   - a text cursor round-trips, is opaque, and carries the sort text ITSELF (no read-back);
//   - a time cursor is refused as a text cursor and the reverse — two versions, never crossed;
//   - malformed cursors, over-long sort texts and wrong-kind ids are REFUSED (a 400), not page one;
//   - the SQL order and predicate read `lower(expr) COLLATE "C"`, as one row-value comparison;
//   - the in-memory comparator orders by UTF-8 bytes, which is what COLLATE "C" does — including
//     the characters above U+FFFF where JavaScript's own `<` disagrees;
//   - a walk with ties on the sort text visits every row exactly once.

import { sql } from "drizzle-orm";
import { PgDialect, pgTable, text, uuid as uuidColumn } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	compareSortText,
	decodeKeysetCursor,
	decodeKeysetTextCursor,
	encodeKeysetCursor,
	encodeKeysetTextCursor,
	KEYSET_DEFAULT_LIMIT,
	keysetTextAfter,
	keysetTextOrderBy,
	keysetTextPage,
	keysetTextPageInMemory,
	keysetTextPageInput,
	keysetTextSortKey,
	type KeysetTextPosition,
} from "@/lib/queries/keyset";

/** A uuid whose trailing digits are `n`, so ids sort predictably. */
function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

const dialect = new PgDialect({ casing: "snake_case" });
const widgets = pgTable("widgets", { id: uuidColumn().primaryKey(), name: text().notNull() });

describe("text cursors", () => {
	it("round-trip, opaquely, carrying the sort text and the id", () => {
		const cursor = encodeKeysetTextCursor({ text: "ada lovelace", id: uuid(7) });
		expect(cursor).not.toContain("ada");
		expect(decodeKeysetTextCursor(cursor)).toEqual({ text: "ada lovelace", id: uuid(7) });
	});

	it("carry any UTF-8 text, empty included", () => {
		for (const t of ["", "zoë", "李雷", "a\u{1F600}b"]) {
			expect(decodeKeysetTextCursor(encodeKeysetTextCursor({ text: t, id: uuid(1) }))?.text).toBe(t);
		}
	});

	it("never cross with time cursors, in either direction", () => {
		const time = encodeKeysetCursor({ at: "2026-01-01T00:00:00.000Z", id: uuid(1) });
		const textual = encodeKeysetTextCursor({ text: "x", id: uuid(1) });
		expect(decodeKeysetTextCursor(time)).toBeNull();
		expect(decodeKeysetCursor(textual)).toBeNull();
	});

	it("refuse garbage, wrong arity, an over-long text and a wrong-kind id", () => {
		const raw = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		expect(decodeKeysetTextCursor("not base64!")).toBeNull();
		expect(decodeKeysetTextCursor(raw(["t1", "x"]))).toBeNull();
		expect(decodeKeysetTextCursor(raw(["t1", 3, uuid(1)]))).toBeNull();
		expect(decodeKeysetTextCursor(raw(["t1", "x".repeat(2049), uuid(1)]))).toBeNull();
		expect(decodeKeysetTextCursor(raw(["t1", "x", "not-a-uuid"]))).toBeNull();
		expect(decodeKeysetTextCursor(raw(["t1", "x", "42"]), "integer")).toEqual({ text: "x", id: "42" });
	});

	it("are a 400 at the input boundary when malformed, and default the limit", () => {
		const input = z.object(keysetTextPageInput("uuid"));
		expect(input.safeParse({ cursor: "garbage" }).success).toBe(false);
		expect(input.safeParse({ limit: 101 }).success).toBe(false);
		const ok = input.parse({ cursor: encodeKeysetTextCursor({ text: "b", id: uuid(2) }) });
		expect(ok).toEqual({ cursor: { text: "b", id: uuid(2) }, limit: KEYSET_DEFAULT_LIMIT });
	});
});

describe("the SQL half", () => {
	it("orders and compares on lower(expr) COLLATE \"C\", then the id, ascending", () => {
		const key = keysetTextSortKey(widgets.name);
		const order = dialect.sqlToQuery(sql.join(keysetTextOrderBy(key, widgets.id), sql`, `)).sql;
		expect(order).toBe('lower("widgets"."name") collate "C" asc, "widgets"."id" asc');
		const after = keysetTextAfter(key, widgets.id, { text: "bob", id: uuid(3) });
		if (after === undefined) throw new Error("a cursor must produce a predicate");
		const q = dialect.sqlToQuery(after);
		expect(q.sql).toBe('(lower("widgets"."name") collate "C", "widgets"."id") > ($1::text collate "C", $2::uuid)');
		expect(q.params).toEqual(["bob", uuid(3)]);
	});

	it("drops out on page one", () => {
		expect(keysetTextAfter(keysetTextSortKey(widgets.name), widgets.id, undefined)).toBeUndefined();
	});
});

describe("compareSortText", () => {
	it("orders by UTF-8 bytes, as COLLATE \"C\" does", () => {
		expect(compareSortText("a", "b")).toBe(-1);
		expect(compareSortText("b", "a")).toBe(1);
		expect(compareSortText("ab", "a")).toBe(1);
		expect(compareSortText("same", "same")).toBe(0);
		// Byte order, not dictionary order: "Z" (0x5A) sorts before "a" (0x61), "_" (0x5F) between.
		expect(["a", "_", "Z"].sort(compareSortText)).toEqual(["Z", "_", "a"]);
	});

	it("puts a character above U+FFFF AFTER U+FFFD, where JavaScript's `<` puts it before", () => {
		const astral = "\u{1F600}";
		const high = "�";
		expect(astral < high).toBe(true);
		expect(compareSortText(astral, high)).toBe(1);
	});
});

describe("paging", () => {
	const rows = [
		{ id: uuid(5), text: "carol" },
		{ id: uuid(2), text: "bob" },
		{ id: uuid(1), text: "bob" },
		{ id: uuid(9), text: "alice" },
		{ id: uuid(4), text: "dave" },
	];
	const keyOf = (r: { id: string; text: string }) => ({ text: r.text, id: r.id });

	it("cuts a fetched page at the limit and mints the cursor from its last row", () => {
		const page = keysetTextPage(rows.slice(0, 3), 2, keyOf);
		expect(page.rows).toHaveLength(2);
		expect(decodeKeysetTextCursor(page.nextCursor ?? "")).toEqual({ text: "bob", id: uuid(2) });
		expect(keysetTextPage(rows.slice(0, 2), 2, keyOf).nextCursor).toBeNull();
	});

	it("walks a composed universe in the SQL order, every row once, across a tie", () => {
		const seen: string[] = [];
		let cursor: KeysetTextPosition | undefined;
		for (let guard = 0; guard < 10; guard += 1) {
			const page = keysetTextPageInMemory(rows, { cursor, limit: 2 }, keyOf);
			seen.push(...page.rows.map((r) => r.id));
			if (page.nextCursor === null) break;
			cursor = decodeKeysetTextCursor(page.nextCursor) ?? undefined;
		}
		// alice, then the two bobs by id ascending, then carol, then dave.
		expect(seen).toEqual([uuid(9), uuid(1), uuid(2), uuid(5), uuid(4)]);
	});

	it("starts strictly after a cursor whose row is gone — the walk does not end", () => {
		// The cursor names a row that is no longer in the universe (deleted between two pages).
		const page = keysetTextPageInMemory(rows, { cursor: { text: "bz", id: uuid(99) }, limit: 10 }, keyOf);
		expect(page.rows.map((r) => r.text)).toEqual(["carol", "dave"]);
	});
});
