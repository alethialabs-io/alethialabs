// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The promotions history's server half (lib/queries/promotions.ts, LST-3 #7485): one SQL keyset
// page of a project's promotions. The transaction is a recording chain — it answers with the rows
// the test scripts and keeps every argument — so what is asserted is the SQL the builder WROTE (the
// project predicate, the ms-truncated row-value cursor, the total order, the `limit + 1` read) and
// how it cuts the answer into a page. That the predicate selects the right rows in Postgres is the
// keyset codec's own test and the tenancy suite's.

import { PgDialect } from "drizzle-orm/pg-core";
import { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/lib/queries/keyset";
import { queryPromotionsPage } from "@/lib/queries/promotions";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const dialect = new PgDialect();

/** A uuid whose last group is `n`, so ids order the way their numbers do. */
function uuidOf(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** A promotion row as the select returns it. */
function promotion(n: number, at: Date) {
	return {
		id: uuidOf(n),
		source_environment_id: "env-dev",
		target_environment_id: "env-prod",
		status: "SUCCEEDED",
		error_message: null,
		created_at: at,
	};
}

/** `n` promotions, newest first, every PAIR sharing one millisecond. */
function history(n: number) {
	const base = Date.UTC(2026, 10, 20);
	return Array.from({ length: n }, (_, i) => promotion(n - i, new Date(base - Math.floor(i / 2) * 1000)));
}

/** A recording select chain answering `rows`, cut to whatever `limit` it is given. */
function recordingTx(rows: ReturnType<typeof history>) {
	const args: Record<string, unknown[]> = {};
	const node = {
		select: (...a: unknown[]) => ((args.select = a), node),
		from: (...a: unknown[]) => ((args.from = a), node),
		where: (...a: unknown[]) => ((args.where = a), node),
		orderBy: (...a: unknown[]) => ((args.orderBy = a), node),
		limit: async (n: number) => {
			args.limit = [n];
			return rows.slice(0, n);
		},
	};
	return { tx: { select: node.select } as unknown as Parameters<typeof queryPromotionsPage>[0], args };
}

/** A recorded SQL argument, rendered. */
function rendered(value: unknown) {
	if (!(value instanceof SQL)) throw new Error("not SQL");
	return dialect.sqlToQuery(value);
}

describe("queryPromotionsPage", () => {
	it("reads limit + 1 in the ms-truncated (created_at, id) order, scoped to the project", async () => {
		const { tx, args } = recordingTx(history(3));
		await queryPromotionsPage(tx, PROJECT, { limit: 2 });
		expect(args.limit).toEqual([3]);
		const order = (args.orderBy ?? []).map((o) => rendered(o).sql);
		expect(order).toEqual([
			`date_trunc('milliseconds', "environment_promotions"."created_at") desc`,
			`"environment_promotions"."id" desc`,
		]);
		const where = rendered(args.where?.[0]);
		expect(where.params).toEqual([PROJECT]);
	});

	it("a cursor adds ONE row-value predicate over the same expression the order reads", async () => {
		const { tx, args } = recordingTx([]);
		const cursor = decodeKeysetCursor(encodeKeysetCursor({ at: "2026-11-20T00:00:00.123Z", id: uuidOf(7) }));
		await queryPromotionsPage(tx, PROJECT, { cursor: cursor ?? undefined, limit: 50 });
		const where = rendered(args.where?.[0]);
		expect(where.sql.replace(/\s+/g, " ")).toContain(
			`(date_trunc('milliseconds', "environment_promotions"."created_at"), "environment_promotions"."id") < ($2::timestamptz, $3::uuid)`,
		);
		expect(where.params).toEqual([PROJECT, "2026-11-20T00:00:00.123Z", uuidOf(7)]);
	});

	it("cuts to `limit` and mints the next cursor from the last KEPT row — a tie boundary included", async () => {
		const rows = history(5);
		const { tx } = recordingTx(rows);
		const page = await queryPromotionsPage(tx, PROJECT, { limit: 3 });
		expect(page.rows.map((r) => r.id)).toEqual(rows.slice(0, 3).map((r) => r.id));
		// Row 3 shares its millisecond with row 4: the cursor carries the id that breaks the tie.
		expect(page.nextCursor).not.toBeNull();
		expect(decodeKeysetCursor(page.nextCursor ?? "")).toEqual({
			at: rows[2].created_at.toISOString(),
			id: rows[2].id,
		});
		expect(page.rows[0].created_at).toBe(rows[0].created_at.toISOString());
	});

	it("says there is no further page exactly when the read came back short", async () => {
		const { tx } = recordingTx(history(3));
		const page = await queryPromotionsPage(tx, PROJECT, { limit: 3 });
		expect(page.nextCursor).toBeNull();
	});

	it("the first page says whether the project has promoted at all; no facets, no count", async () => {
		const empty = await queryPromotionsPage(recordingTx([]).tx, PROJECT);
		expect(empty).toEqual({ rows: [], nextCursor: null, facets: null, universeEmpty: true });
		const some = await queryPromotionsPage(recordingTx(history(1)).tx, PROJECT);
		expect(some.universeEmpty).toBe(false);
		expect(some).not.toHaveProperty("total");
	});

	it("a later page carries neither facets nor the emptiness probe", async () => {
		const cursor = decodeKeysetCursor(encodeKeysetCursor({ at: "2026-11-20T00:00:00.000Z", id: uuidOf(9) }));
		const page = await queryPromotionsPage(recordingTx([]).tx, PROJECT, { cursor: cursor ?? undefined, limit: 50 });
		expect(page).toMatchObject({ facets: null, universeEmpty: null });
	});
});
