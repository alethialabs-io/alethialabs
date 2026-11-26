// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The billing ledgers' page builders (lib/queries/billing.ts, LST-11 #7493).
//
// queryTransactionsPage over a STUBBED Stripe client: the defect this replaces read `limit: 24` and
// nothing after it, so the test that matters is the one that pages PAST the first Stripe page —
// the second request must carry `starting_after` = the last charge of the first, and Stripe's
// `has_more: false` must end the walk.
//
// queryInvoicesPage over the recording chain db (`_list-query-db.ts`): the page boundary (read
// `limit + 1`, cut to `limit`, a cursor only when a further row exists — so a last page of exactly
// `limit` rows says null), ties on the listed-at instant broken by the id, and the two passes — a
// filtered ROWS pass and a facet pass that sees only the org scope, on the first page only. The
// F7 test (`filter-standard-facets.test.ts`) derives its subjects from builders that RETURN a
// `facets:` key; this one assembles its page through `keysetListPage`, so the two-pass shape is
// asserted here instead.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getServiceDb, chargesList } = vi.hoisted(() => ({
	getServiceDb: vi.fn(),
	chargesList: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getServiceDb }));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: () => ({ charges: { list: chargesList } }) }));

import { type InvoiceListRow, queryInvoicesPage, queryTransactionsPage } from "@/lib/queries/billing";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/lib/queries/keyset";
import { mockChainDb, type RecordedChain } from "./_list-query-db";

/** A Stripe charge as `charges.list` returns it (only the fields the mapping reads). */
function stripeCharge(n: number) {
	return {
		id: `ch_${n}`,
		description: `Charge ${n}`,
		status: "succeeded",
		amount: 1000 + n,
		amount_refunded: 0,
		refunded: false,
		currency: "eur",
		created: 1_780_000_000 + n,
		payment_method_details: { card: { brand: "visa", last4: "4242" } },
	};
}

/** A uuid whose trailing digits are `n`. */
function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** A mirrored invoice row (only what the builder and its key read are meaningful). */
function invoiceRow(n: number, paidAt: string | null) {
	return {
		id: uuid(n),
		organizationId: "org-1",
		status: "paid",
		paidAt: paidAt === null ? null : new Date(paidAt),
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
	};
}

/** A mirrored Paddle transaction row (only what the builder, its key and its status read matter). */
function paddleRow(n: number, billedAt: string | null) {
	return {
		id: uuid(n),
		organizationId: "org-1",
		paddleTransactionId: `txn_${n}`,
		status: "completed",
		billedAt: billedAt === null ? null : new Date(billedAt),
		refundedAt: null,
		chargebackAt: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
	};
}

/** A list row's ordering id (the row uuid, of either source). */
function rowId(row: InvoiceListRow): string {
	return row.source === "invoice" ? row.invoice.id : row.transaction.id;
}

/** A list row as `source:id`, so a test reads which table each row came from. */
function tagged(row: InvoiceListRow): string {
	return `${row.source}:${rowId(row)}`;
}

/**
 * Every string and instant leaf of a value (a drizzle predicate is an object tree), cycle-safe.
 * Instants are read too, so a date bound that reached a pass shows up as its ISO string.
 */
function leaves(value: unknown, seen = new Set<object>(), out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	if (value instanceof Date) out.push(value.toISOString());
	if (value === null || typeof value !== "object" || seen.has(value)) return out;
	seen.add(value);
	for (const v of Object.values(value)) leaves(v, seen, out);
	return out;
}

/** The string leaves of everything a chain's `where` was handed. */
function whereLeaves(chain: RecordedChain | undefined): string[] {
	return leaves(chain?.calls.filter((c) => c.method === "where").map((c) => c.args) ?? []);
}

/** The value one chain passed to `.limit(...)`. */
function limitOf(chain: RecordedChain | undefined): unknown {
	return chain?.argsOf("limit")?.[0];
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("queryTransactionsPage — Stripe's cursor on the console contract", () => {
	it("pages PAST the first Stripe page, and Stripe's has_more ends the walk", async () => {
		const firstPage = Array.from({ length: 50 }, (_, i) => stripeCharge(100 - i));
		chargesList.mockResolvedValueOnce({ data: firstPage, has_more: true });
		chargesList.mockResolvedValueOnce({ data: [stripeCharge(50), stripeCharge(49)], has_more: false });

		const one = await queryTransactionsPage("cus_1", { limit: 50 });
		expect(chargesList).toHaveBeenLastCalledWith({ customer: "cus_1", limit: 50 });
		expect(one.rows).toHaveLength(50);
		expect(one.rows[0]).toMatchObject({ id: "ch_100", status: "paid", amount: 1100, method: "visa ···· 4242" });
		expect(one.facets).toBeNull();
		expect(one.universeEmpty).toBe(false);
		// The cursor is the console's opaque one, carrying the LAST charge of the page.
		expect(one.nextCursor).not.toBeNull();
		const position = decodeKeysetCursor(one.nextCursor ?? "", "text");
		expect(position).toEqual({ at: new Date((1_780_000_000 + 51) * 1000).toISOString(), id: "ch_51" });

		const two = await queryTransactionsPage("cus_1", { cursor: position ?? undefined, limit: 50 });
		expect(chargesList).toHaveBeenLastCalledWith({ customer: "cus_1", limit: 50, starting_after: "ch_51" });
		expect(two.rows.map((r) => r.id)).toEqual(["ch_50", "ch_49"]);
		expect(two.nextCursor).toBeNull();
		// A later page carries no first-page extras.
		expect(two.facets).toBeNull();
		expect(two.universeEmpty).toBeNull();
	});

	it("a full page with nothing after it is the last page (has_more decides, not the row count)", async () => {
		chargesList.mockResolvedValueOnce({ data: [stripeCharge(2), stripeCharge(1)], has_more: false });
		const only = await queryTransactionsPage("cus_1", { limit: 2 });
		expect(only.rows).toHaveLength(2);
		expect(only.nextCursor).toBeNull();
	});

	it("an org with no Stripe customer is an empty, final first page — and Stripe is never asked", async () => {
		const none = await queryTransactionsPage(null, { limit: 50 });
		expect(chargesList).not.toHaveBeenCalled();
		expect(none).toEqual({ rows: [], nextCursor: null, facets: null, universeEmpty: true });
	});
});

describe("queryInvoicesPage — keyset over the mirrored table", () => {
	it("reads limit + 1, cuts to limit, and mints the cursor from the last KEPT row", async () => {
		// Three rows for a page of two: the third proves a further page exists.
		const rows = [
			invoiceRow(3, "2026-06-03T00:00:00.000Z"),
			invoiceRow(2, "2026-06-02T00:00:00.000Z"),
			invoiceRow(1, "2026-06-01T00:00:00.000Z"),
		];
		const { db, chains } = mockChainDb([rows, [], [{ status: "paid", n: 3 }], []]);
		getServiceDb.mockReturnValue(db);

		const page = await queryInvoicesPage("org-1", {}, { limit: 2 });
		expect(limitOf(chains[0])).toBe(3);
		expect(page.rows.map(rowId)).toEqual([uuid(3), uuid(2)]);
		expect(decodeKeysetCursor(page.nextCursor ?? "")).toEqual({ at: "2026-06-02T00:00:00.000Z", id: uuid(2) });
		expect(page.facets).toEqual({ status: [{ value: "paid", label: null, count: 3 }] });
		expect(page.universeEmpty).toBe(false);
	});

	it("a last page of exactly limit rows says null, not a cursor to an empty page", async () => {
		const { db } = mockChainDb([[invoiceRow(2, "2026-06-02T00:00:00.000Z"), invoiceRow(1, "2026-06-01T00:00:00.000Z")], [], [], []]);
		getServiceDb.mockReturnValue(db);
		const page = await queryInvoicesPage("org-1", {}, { limit: 2 });
		expect(page.rows).toHaveLength(2);
		expect(page.nextCursor).toBeNull();
		// No invoice at all in the org's universe: the first-run state, a boolean.
		expect(page.universeEmpty).toBe(true);
	});

	it("ties on the listed-at instant are broken by the id, which the cursor carries", async () => {
		const same = "2026-06-01T00:00:00.000Z";
		const { db } = mockChainDb([[invoiceRow(9, same), invoiceRow(8, same), invoiceRow(7, same)], [], [], []]);
		getServiceDb.mockReturnValue(db);
		const page = await queryInvoicesPage("org-1", {}, { limit: 2 });
		// The cursor names the second row by id, so the next page starts strictly after IT — row 7 —
		// rather than after the instant, which would skip every row sharing it.
		expect(decodeKeysetCursor(page.nextCursor ?? "")).toEqual({ at: same, id: uuid(8) });

		const later = mockChainDb([[invoiceRow(7, same)]]);
		getServiceDb.mockReturnValue(later.db);
		const next = await queryInvoicesPage("org-1", {}, { cursor: { at: same, id: uuid(8) }, limit: 2 });
		expect(whereLeaves(later.chains[0]).join(" ")).toContain(uuid(8));
		expect(next.rows.map(rowId)).toEqual([uuid(7)]);
		expect(next.nextCursor).toBeNull();
	});

	it("an unpaid (mirrored-early) row is keyed by its mirror time, the date the list shows", async () => {
		const { db } = mockChainDb([[invoiceRow(2, "2026-06-02T00:00:00.000Z"), invoiceRow(1, null), invoiceRow(0, null)], [], [], []]);
		getServiceDb.mockReturnValue(db);
		const page = await queryInvoicesPage("org-1", {}, { limit: 2 });
		expect(page.nextCursor).toBe(encodeKeysetCursor({ at: "2026-01-01T00:00:00.000Z", id: uuid(1) }));
	});

	it("filters narrow the rows pass only; the facet pass sees the org scope alone, on page one only", async () => {
		const filtered = mockChainDb([[], [], [], []]);
		getServiceDb.mockReturnValue(filtered.db);
		await queryInvoicesPage(
			"org-1",
			{ status: ["void"], paidFrom: "2026-01-01T00:00:00.000Z", paidTo: "2026-02-01T00:00:00.000Z" },
			{ limit: 50 },
		);
		const unfiltered = mockChainDb([[], [], [], []]);
		getServiceDb.mockReturnValue(unfiltered.db);
		await queryInvoicesPage("org-1", {}, { limit: 50 });

		// Creation order: invoice rows, Paddle rows, invoice facet, Paddle facet.
		const [rowsPass, paddleRowsPass, facetPass, paddleFacetPass] = filtered.chains;
		// The control: the filters DID reach the rows pass (without it, every assertion below holds
		// for a builder that ignores its filters).
		expect(whereLeaves(rowsPass)).toEqual(
			expect.arrayContaining(["void", "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"]),
		);
		expect(facetPass?.called("groupBy")).toBe(true);
		expect(whereLeaves(facetPass)).toContain("org-1");
		// The facet pass's predicates are IDENTICAL with and without the filters.
		expect(whereLeaves(facetPass)).toEqual(whereLeaves(unfiltered.chains[2]));
		// The same holds for the Paddle half: the filters reach its rows pass, never its facet pass.
		expect(whereLeaves(paddleRowsPass)).toEqual(
			expect.arrayContaining(["void", "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"]),
		);
		expect(paddleFacetPass?.called("groupBy")).toBe(true);
		expect(whereLeaves(paddleFacetPass)).toContain("org-1");
		expect(whereLeaves(paddleFacetPass)).not.toContain("void");
		expect(whereLeaves(paddleFacetPass)).toEqual(whereLeaves(unfiltered.chains[3]));

		const later = mockChainDb([[], []]);
		getServiceDb.mockReturnValue(later.db);
		const page = await queryInvoicesPage("org-1", { status: ["void"] }, { cursor: { at: "2026-06-01T00:00:00.000Z", id: uuid(1) }, limit: 50 });
		// Two rows passes (one per source), no facet pass.
		expect(later.chains).toHaveLength(2);
		expect(page.facets).toBeNull();
		expect(page.universeEmpty).toBeNull();
	});
});

describe("queryInvoicesPage — Paddle invoices on the same page and the same cursor", () => {
	it("merges mirrored Paddle invoices with local ones in date order", async () => {
		const { db } = mockChainDb([
			[invoiceRow(5, "2026-06-05T00:00:00.000Z"), invoiceRow(2, "2026-06-02T00:00:00.000Z")],
			[paddleRow(4, "2026-06-04T00:00:00.000Z"), paddleRow(3, "2026-06-03T00:00:00.000Z"), paddleRow(1, "2026-06-01T00:00:00.000Z")],
			[{ status: "paid", n: 2 }],
			[{ status: "paid", n: 3 }],
		]);
		getServiceDb.mockReturnValue(db);
		const page = await queryInvoicesPage("org-1", {}, { limit: 10 });
		expect(page.rows.map(tagged)).toEqual([
			`invoice:${uuid(5)}`,
			`paddle:${uuid(4)}`,
			`paddle:${uuid(3)}`,
			`invoice:${uuid(2)}`,
			`paddle:${uuid(1)}`,
		]);
		expect(page.nextCursor).toBeNull();
		// The universe is both sources: "paid" counts the 2 local and the 3 Paddle invoices.
		expect(page.facets).toEqual({ status: [{ value: "paid", label: null, count: 5 }] });
		expect(page.universeEmpty).toBe(false);
	});

	it("an org with only Paddle invoices is not an empty universe", async () => {
		const { db } = mockChainDb([[], [paddleRow(1, "2026-06-01T00:00:00.000Z")], [], [{ status: "paid", n: 1 }]]);
		getServiceDb.mockReturnValue(db);
		const page = await queryInvoicesPage("org-1", {}, { limit: 10 });
		expect(page.rows.map(tagged)).toEqual([`paddle:${uuid(1)}`]);
		expect(page.universeEmpty).toBe(false);
	});

	it("a page boundary between a local and a Paddle row: the cursor carries the Paddle row, both sources resume after it", async () => {
		// Page of 2 over local {6, 3} and Paddle {5, 4}: the merge keeps 6 and Paddle 5, and Paddle 4
		// proves a further page.
		const first = mockChainDb([
			[invoiceRow(6, "2026-06-06T00:00:00.000Z"), invoiceRow(3, "2026-06-03T00:00:00.000Z")],
			[paddleRow(5, "2026-06-05T00:00:00.000Z"), paddleRow(4, "2026-06-04T00:00:00.000Z")],
			[],
			[],
		]);
		getServiceDb.mockReturnValue(first.db);
		const one = await queryInvoicesPage("org-1", {}, { limit: 2 });
		// Both sources were asked for limit + 1.
		expect(limitOf(first.chains[0])).toBe(3);
		expect(limitOf(first.chains[1])).toBe(3);
		expect(one.rows.map(tagged)).toEqual([`invoice:${uuid(6)}`, `paddle:${uuid(5)}`]);
		const position = decodeKeysetCursor(one.nextCursor ?? "");
		expect(position).toEqual({ at: "2026-06-05T00:00:00.000Z", id: uuid(5) });

		const second = mockChainDb([[invoiceRow(3, "2026-06-03T00:00:00.000Z")], [paddleRow(4, "2026-06-04T00:00:00.000Z")]]);
		getServiceDb.mockReturnValue(second.db);
		const two = await queryInvoicesPage("org-1", {}, { cursor: position ?? undefined, limit: 2 });
		// The ONE cursor reached BOTH sources' rows passes.
		expect(whereLeaves(second.chains[0])).toContain(uuid(5));
		expect(whereLeaves(second.chains[1])).toContain(uuid(5));
		expect(two.rows.map(tagged)).toEqual([`paddle:${uuid(4)}`, `invoice:${uuid(3)}`]);
		expect(two.nextCursor).toBeNull();
	});

	it("a tie on the instant across sources is broken by the uuid, as Postgres orders it", async () => {
		const same = "2026-06-01T00:00:00.000Z";
		const { db } = mockChainDb([[invoiceRow(7, same)], [paddleRow(8, same), paddleRow(6, same)], [], []]);
		getServiceDb.mockReturnValue(db);
		const page = await queryInvoicesPage("org-1", {}, { limit: 2 });
		expect(page.rows.map(tagged)).toEqual([`paddle:${uuid(8)}`, `invoice:${uuid(7)}`]);
		expect(decodeKeysetCursor(page.nextCursor ?? "")).toEqual({ at: same, id: uuid(7) });
	});

	it("the status facet folds Paddle refunds into the same options as local ones", async () => {
		const { db } = mockChainDb([
			[],
			[],
			[
				{ status: "paid", n: 4 },
				{ status: "void", n: 1 },
			],
			[
				{ status: "paid", n: 2 },
				{ status: "refunded", n: 1 },
			],
		]);
		getServiceDb.mockReturnValue(db);
		const page = await queryInvoicesPage("org-1", {}, { limit: 10 });
		expect(page.facets?.status).toEqual(
			expect.arrayContaining([
				{ value: "paid", label: null, count: 6 },
				{ value: "void", label: null, count: 1 },
				{ value: "refunded", label: null, count: 1 },
			]),
		);
		expect(page.facets?.status).toHaveLength(3);
	});

	it("the Paddle half reads the org's transactions Paddle invoiced, past-due ones included", async () => {
		const { db, chains } = mockChainDb([[], [], [], []]);
		getServiceDb.mockReturnValue(db);
		await queryInvoicesPage("org-1", {}, { limit: 10 });
		for (const chain of [chains[1], chains[3]]) {
			expect(whereLeaves(chain)).toEqual(
				expect.arrayContaining(["org-1", "billed", "past_due", "paid", "completed", "canceled"]),
			);
			expect(whereLeaves(chain)).not.toContain("draft");
			expect(whereLeaves(chain)).not.toContain("ready");
		}
	});

	it("an open/overdue-only filter matches no Stripe-era row and never sends those values to its enum", async () => {
		const { db, chains } = mockChainDb([[], [], [], []]);
		getServiceDb.mockReturnValue(db);
		await queryInvoicesPage("org-1", { status: ["open", "overdue"] }, { limit: 10 });
		expect(whereLeaves(chains[0])).not.toContain("open");
		expect(whereLeaves(chains[0])).not.toContain("overdue");
		expect(whereLeaves(chains[1])).toEqual(expect.arrayContaining(["open", "overdue"]));
	});

	it("a mixed filter passes only the stored statuses to the Stripe-era pass", async () => {
		const { db, chains } = mockChainDb([[], [], [], []]);
		getServiceDb.mockReturnValue(db);
		await queryInvoicesPage("org-1", { status: ["overdue", "paid"] }, { limit: 10 });
		expect(whereLeaves(chains[0])).toContain("paid");
		expect(whereLeaves(chains[0])).not.toContain("overdue");
	});

	it("the status facet carries the Paddle-only open and overdue options", async () => {
		const { db } = mockChainDb([
			[],
			[],
			[{ status: "paid", n: 1 }],
			[
				{ status: "open", n: 2 },
				{ status: "overdue", n: 1 },
			],
		]);
		getServiceDb.mockReturnValue(db);
		const page = await queryInvoicesPage("org-1", {}, { limit: 10 });
		expect(page.facets?.status).toEqual(
			expect.arrayContaining([
				{ value: "paid", label: null, count: 1 },
				{ value: "open", label: null, count: 2 },
				{ value: "overdue", label: null, count: 1 },
			]),
		);
	});
});
