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

import { queryInvoicesPage, queryTransactionsPage } from "@/lib/queries/billing";
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
		const { db, chains } = mockChainDb([rows, [{ status: "paid", n: 3 }]]);
		getServiceDb.mockReturnValue(db);

		const page = await queryInvoicesPage("org-1", {}, { limit: 2 });
		expect(limitOf(chains[0])).toBe(3);
		expect(page.rows.map((r) => r.id)).toEqual([uuid(3), uuid(2)]);
		expect(decodeKeysetCursor(page.nextCursor ?? "")).toEqual({ at: "2026-06-02T00:00:00.000Z", id: uuid(2) });
		expect(page.facets).toEqual({ status: [{ value: "paid", label: null, count: 3 }] });
		expect(page.universeEmpty).toBe(false);
	});

	it("a last page of exactly limit rows says null, not a cursor to an empty page", async () => {
		const { db } = mockChainDb([[invoiceRow(2, "2026-06-02T00:00:00.000Z"), invoiceRow(1, "2026-06-01T00:00:00.000Z")], []]);
		getServiceDb.mockReturnValue(db);
		const page = await queryInvoicesPage("org-1", {}, { limit: 2 });
		expect(page.rows).toHaveLength(2);
		expect(page.nextCursor).toBeNull();
		// No invoice at all in the org's universe: the first-run state, a boolean.
		expect(page.universeEmpty).toBe(true);
	});

	it("ties on the listed-at instant are broken by the id, which the cursor carries", async () => {
		const same = "2026-06-01T00:00:00.000Z";
		const { db } = mockChainDb([[invoiceRow(9, same), invoiceRow(8, same), invoiceRow(7, same)], []]);
		getServiceDb.mockReturnValue(db);
		const page = await queryInvoicesPage("org-1", {}, { limit: 2 });
		// The cursor names the second row by id, so the next page starts strictly after IT — row 7 —
		// rather than after the instant, which would skip every row sharing it.
		expect(decodeKeysetCursor(page.nextCursor ?? "")).toEqual({ at: same, id: uuid(8) });

		const later = mockChainDb([[invoiceRow(7, same)]]);
		getServiceDb.mockReturnValue(later.db);
		const next = await queryInvoicesPage("org-1", {}, { cursor: { at: same, id: uuid(8) }, limit: 2 });
		expect(whereLeaves(later.chains[0]).join(" ")).toContain(uuid(8));
		expect(next.rows.map((r) => r.id)).toEqual([uuid(7)]);
		expect(next.nextCursor).toBeNull();
	});

	it("an unpaid (mirrored-early) row is keyed by its mirror time, the date the list shows", async () => {
		const { db } = mockChainDb([[invoiceRow(2, "2026-06-02T00:00:00.000Z"), invoiceRow(1, null), invoiceRow(0, null)], []]);
		getServiceDb.mockReturnValue(db);
		const page = await queryInvoicesPage("org-1", {}, { limit: 2 });
		expect(page.nextCursor).toBe(encodeKeysetCursor({ at: "2026-01-01T00:00:00.000Z", id: uuid(1) }));
	});

	it("filters narrow the rows pass only; the facet pass sees the org scope alone, on page one only", async () => {
		const filtered = mockChainDb([[], []]);
		getServiceDb.mockReturnValue(filtered.db);
		await queryInvoicesPage(
			"org-1",
			{ status: ["void"], paidFrom: "2026-01-01T00:00:00.000Z", paidTo: "2026-02-01T00:00:00.000Z" },
			{ limit: 50 },
		);
		const unfiltered = mockChainDb([[], []]);
		getServiceDb.mockReturnValue(unfiltered.db);
		await queryInvoicesPage("org-1", {}, { limit: 50 });

		const [rowsPass, facetPass] = filtered.chains;
		// The control: the filters DID reach the rows pass (without it, every assertion below holds
		// for a builder that ignores its filters).
		expect(whereLeaves(rowsPass)).toEqual(
			expect.arrayContaining(["void", "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"]),
		);
		expect(facetPass?.called("groupBy")).toBe(true);
		expect(whereLeaves(facetPass)).toContain("org-1");
		// The facet pass's predicates are IDENTICAL with and without the filters.
		expect(whereLeaves(facetPass)).toEqual(whereLeaves(unfiltered.chains[1]));

		const later = mockChainDb([[]]);
		getServiceDb.mockReturnValue(later.db);
		const page = await queryInvoicesPage("org-1", { status: ["void"] }, { cursor: { at: "2026-06-01T00:00:00.000Z", id: uuid(1) }, limit: 50 });
		expect(later.chains).toHaveLength(1);
		expect(page.facets).toBeNull();
		expect(page.universeEmpty).toBeNull();
	});
});
