// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

// The billing ledgers' page builders (lib/query/README.md → "Paging"; epic #7481, LST-11 #7493):
// the org's mirrored invoices and its Stripe charges, each on the console's ONE paging contract —
// `KeysetListPage` (lib/queries/keyset.ts).
//
// Both replaced a read that silently dropped rows. The invoices page read the newest 200 (and the
// input allowed 500) and paged them in the browser; the transaction history read Stripe with
// `limit: 24` and paged THOSE in the browser, so charge 25 and every one after it was unreachable
// from the console. On a money ledger that is the worst way for a list to be wrong: it looks
// complete.
//
// TWO SOURCES, ONE CONTRACT. Invoices are our own tables, so they page in SQL through the shared
// codec: ordered by the display date (`paid_at`, falling back to `created_at`, which is exactly
// what `InvoiceInfo.paidAt` shows) truncated to ms, then the id.
//
// "Our own tables" is two since Paddle (L1/L3/L5): Paddle is the merchant of record, so a Paddle
// customer's invoices are PADDLE's documents, and every one of them is mirrored in
// `paddle_transaction` by the webhook (lib/billing/events/apply.ts — a transaction event resolves
// its org from the subscription first and is mirrored, or alerted when it cannot be). The invoices
// page is the union of the Stripe-era `invoice` mirror and the org's billed/completed Paddle
// transactions. Both tables key on a uuid `id`, so ONE cursor `(listed_at, id)` walks both: each
// source is read in SQL with the same `keysetAfter` predicate and `limit + 1`, and the two sorted
// runs are merged here by the same `(listed_at desc, id desc)` order Postgres used. The merged
// first `limit + 1` rows are exactly the union's next `limit + 1`, because no row of either source
// that ranks above them can be missing from its own source's first `limit + 1`. A SQL `UNION ALL`
// would answer the same rows, but its projection is a hand-written shape that loses the schema's
// inferred row types; two typed reads of at most `limit + 1` rows each cost the same. Charges live in Stripe, which owns
// the order (newest first) and has its own cursor, `starting_after` — the id of the last charge
// seen. The page maps that onto the SAME opaque cursor (`encodeKeysetCursor` over the charge's
// creation instant and id, text-kind id), so the browser cannot tell the two apart, a malformed
// cursor is a 400 at the boundary for both, and Stripe's own `has_more` says whether a next page
// exists — no `limit + 1` probe needed.

import type { SQL } from "drizzle-orm";
import { and, count, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type Stripe from "stripe";
import type { InvoiceListFilters } from "@/lib/billing/invoices";
import { getStripe } from "@/lib/billing/stripe";
import { getServiceDb } from "@/lib/db";
import { type Invoice, invoice, type PaddleTransaction, paddleTransaction } from "@/lib/db/schema";
import type { InvoiceStatus } from "@/lib/db/schema/enums";
import type { FacetOption } from "./facets";
import {
	encodeKeysetCursor,
	type KeysetListPage,
	type KeysetPageRequest,
	keysetAfter,
	keysetFetchLimit,
	keysetListPage,
	keysetOrderBy,
	keysetPage,
	keysetSortKey,
} from "./keyset";

// ── Invoices (our mirrored tables) ─────────────────────────────────────────────────────────────

/** The invoices list's facets: status options counted over the org's UNFILTERED invoices. */
export interface InvoiceFacets {
	status: FacetOption[];
}

/** The invoice filters a page applies — the reader's filters without the retired `limit`. */
export type InvoicePageFilters = Omit<InvoiceListFilters, "limit">;

/** One row of the invoices list: a Stripe-era mirrored invoice, or a mirrored Paddle invoice. */
export type InvoiceListRow =
	| { source: "invoice"; invoice: Invoice }
	| { source: "paddle"; transaction: PaddleTransaction };

/**
 * The instant an invoice is listed under: when it was paid, or when we mirrored it if Stripe never
 * told us (a row from before `paid_at` was captured). The same fallback `InvoiceInfo.paidAt`
 * renders, so the order the list walks is the order the "Paid" column reads.
 */
const INVOICE_LISTED_AT: SQL = keysetSortKey(sql`coalesce(${invoice.paidAt}, ${invoice.createdAt})`);

/** A Paddle invoice's listed-at instant: when Paddle billed it, else when we mirrored it. */
const PADDLE_LISTED_AT: SQL = keysetSortKey(
	sql`coalesce(${paddleTransaction.billedAt}, ${paddleTransaction.createdAt})`,
);

/**
 * The Paddle statuses that are invoices — the same two Paddle's own list asks for
 * (lib/billing/paddle/documents.ts `listPaddleDocuments`). A draft, ready or past-due
 * transaction has no invoice yet; a canceled one never will.
 */
const PADDLE_INVOICE_STATUSES = ["billed", "completed"] as const;

/**
 * A Paddle invoice's status on the list's closed `invoice_status` scale: `refunded` once an
 * approved refund or a chargeback was recorded against it (money went back either way), else
 * `paid`. Never `void` — Paddle has no voided invoice. The SQL twin is {@link PADDLE_STATUS_SQL}.
 */
export function paddleInvoiceStatus(row: Pick<PaddleTransaction, "refundedAt" | "chargebackAt">): InvoiceStatus {
	return row.refundedAt !== null || row.chargebackAt !== null ? "refunded" : "paid";
}

/** {@link paddleInvoiceStatus} in SQL, so the status filter and facet read the same answer. */
const PADDLE_STATUS_SQL: SQL<string> = sql<string>`case when ${paddleTransaction.refundedAt} is not null or ${paddleTransaction.chargebackAt} is not null then 'refunded' else 'paid' end`;

/** A facet value read back from {@link PADDLE_STATUS_SQL}, on the closed scale. */
function paddleFacetStatus(value: string): InvoiceStatus {
	return value === "refunded" ? "refunded" : "paid";
}

/** A row's keyset position, by the same fallbacks as the two listed-at expressions. */
function invoiceListRowKey(row: InvoiceListRow): { at: Date; id: string } {
	if (row.source === "invoice") return { at: row.invoice.paidAt ?? row.invoice.createdAt, id: row.invoice.id };
	return { at: row.transaction.billedAt ?? row.transaction.createdAt, id: row.transaction.id };
}

/**
 * The list's order — listed-at descending, then id descending — over rows of either source. Ids
 * are lowercase canonical uuids, whose string order is Postgres's uuid (byte) order, so this is
 * the order each source's SQL read already returned its own rows in.
 */
function compareInvoiceListRows(a: InvoiceListRow, b: InvoiceListRow): number {
	const ka = invoiceListRowKey(a);
	const kb = invoiceListRowKey(b);
	const byAt = kb.at.getTime() - ka.at.getTime();
	if (byAt !== 0) return byAt;
	return kb.id < ka.id ? -1 : kb.id > ka.id ? 1 : 0;
}

/**
 * The first page's extras: the status facet over the org's UNFILTERED invoices of BOTH sources
 * (only the scope predicates — an option must not vanish the moment it is picked), and whether the
 * org has any invoice at all. One grouped pass per source answers both; `universeEmpty` stays a
 * boolean.
 */
async function invoiceFirstPage(orgId: string): Promise<{ facets: InvoiceFacets; universeEmpty: boolean }> {
	const db = getServiceDb();
	const [local, paddle] = await Promise.all([
		db
			.select({ status: invoice.status, n: count() })
			.from(invoice)
			.where(eq(invoice.organizationId, orgId))
			.groupBy(invoice.status),
		db
			.select({ status: PADDLE_STATUS_SQL, n: count() })
			.from(paddleTransaction)
			.where(paddleScope(orgId))
			.groupBy(PADDLE_STATUS_SQL),
	]);
	const counts = new Map<InvoiceStatus, number>();
	for (const c of local) counts.set(c.status, (counts.get(c.status) ?? 0) + c.n);
	for (const c of paddle) {
		const status = paddleFacetStatus(c.status);
		counts.set(status, (counts.get(status) ?? 0) + c.n);
	}
	const status = [...counts].map(([value, n]) => ({ value, label: null, count: n }));
	return { facets: { status }, universeEmpty: status.every((c) => c.count === 0) };
}

/** The scope of the org's Paddle invoices: its own mirrored, billed or completed transactions. */
function paddleScope(orgId: string): SQL | undefined {
	return and(
		eq(paddleTransaction.organizationId, orgId),
		inArray(paddleTransaction.status, [...PADDLE_INVOICE_STATUSES]),
	);
}

/**
 * One page of an org's invoices — the Stripe-era mirror and the mirrored Paddle invoices together
 * — newest first. `orgId` is the resolved actor's (never user input); the filters narrow the ROWS
 * passes only, and the paid-date range reads each source's own paid instant (`paid_at`, Paddle's
 * `billed_at`). Facets and `universeEmpty` come with the first page (no cursor) and are null after.
 */
export async function queryInvoicesPage(
	orgId: string,
	filters: InvoicePageFilters,
	request: KeysetPageRequest,
): Promise<KeysetListPage<InvoiceListRow, InvoiceFacets>> {
	const local: (SQL | undefined)[] = [eq(invoice.organizationId, orgId)];
	if (filters.status?.length) local.push(inArray(invoice.status, filters.status));
	if (filters.paidFrom) local.push(gte(invoice.paidAt, new Date(filters.paidFrom)));
	if (filters.paidTo) local.push(lte(invoice.paidAt, new Date(filters.paidTo)));
	local.push(keysetAfter(INVOICE_LISTED_AT, invoice.id, request.cursor));

	const hosted: (SQL | undefined)[] = [paddleScope(orgId)];
	if (filters.status?.length) hosted.push(inArray(PADDLE_STATUS_SQL, filters.status));
	if (filters.paidFrom) hosted.push(gte(paddleTransaction.billedAt, new Date(filters.paidFrom)));
	if (filters.paidTo) hosted.push(lte(paddleTransaction.billedAt, new Date(filters.paidTo)));
	hosted.push(keysetAfter(PADDLE_LISTED_AT, paddleTransaction.id, request.cursor));

	const db = getServiceDb();
	const fetchLimit = keysetFetchLimit(request.limit);
	const [invoices, transactions] = await Promise.all([
		db
			.select()
			.from(invoice)
			.where(and(...local))
			.orderBy(...keysetOrderBy(INVOICE_LISTED_AT, invoice.id))
			.limit(fetchLimit),
		db
			.select()
			.from(paddleTransaction)
			.where(and(...hosted))
			.orderBy(...keysetOrderBy(PADDLE_LISTED_AT, paddleTransaction.id))
			.limit(fetchLimit),
	]);
	const merged: InvoiceListRow[] = [
		...invoices.map((row): InvoiceListRow => ({ source: "invoice", invoice: row })),
		...transactions.map((row): InvoiceListRow => ({ source: "paddle", transaction: row })),
	]
		.sort(compareInvoiceListRows)
		.slice(0, fetchLimit);
	const page = keysetPage(merged, request.limit, invoiceListRowKey);
	return keysetListPage(page, request.cursor === undefined ? await invoiceFirstPage(orgId) : null);
}

// ── Transactions (Stripe charges) ───────────────────────────────────────────────────────────────

/** A charge row for the transaction-history table. */
export interface TransactionInfo {
	id: string;
	/** What the charge was for (Stripe description, or a sensible fallback). */
	description: string;
	/** Normalized outcome driving the status badge. */
	status: "paid" | "pending" | "failed" | "refunded";
	/** Smallest-unit amount; negative for refunds. */
	amount: number;
	currency: string;
	created: string;
	/** "Visa ···· 4242", or null when the method isn't a card. */
	method: string | null;
}

/** Maps a Stripe charge to our normalized transaction shape. */
export function toTransaction(charge: Stripe.Charge): TransactionInfo {
	const card = charge.payment_method_details?.card;
	const method = card ? `${card.brand ?? "card"} ···· ${card.last4 ?? "••••"}` : null;
	const refunded = charge.refunded || charge.amount_refunded > 0;
	const status: TransactionInfo["status"] = refunded
		? "refunded"
		: charge.status === "succeeded"
			? "paid"
			: charge.status === "failed"
				? "failed"
				: "pending";
	return {
		id: charge.id,
		description: charge.description ?? "Subscription payment",
		status,
		amount: refunded ? -charge.amount_refunded : charge.amount,
		currency: charge.currency,
		created: new Date(charge.created * 1000).toISOString(),
		method,
	};
}

/** The answer for an org with no Stripe customer: no charges, and nothing further to page. */
const NO_CHARGES: Pick<Stripe.ApiList<Stripe.Charge>, "data" | "has_more"> = { data: [], has_more: false };

/**
 * One page of a Stripe customer's charges, newest first (Stripe's own order). The cursor's id is
 * the last charge of the previous page, handed to Stripe as `starting_after`; `has_more` decides
 * `nextCursor`. A null `customerId` (the org never paid) is an empty, final first page.
 *
 * There is no facet pass: the history has no filter bar, so its first page carries `facets: null`
 * and only the `universeEmpty` answer the empty state needs.
 */
export async function queryTransactionsPage(
	customerId: string | null,
	request: KeysetPageRequest,
): Promise<KeysetListPage<TransactionInfo, null>> {
	const list =
		customerId === null
			? NO_CHARGES
			: await getStripe().charges.list({
					customer: customerId,
					limit: request.limit,
					...(request.cursor === undefined ? {} : { starting_after: request.cursor.id }),
				});
	const last = list.data.at(-1);
	const nextCursor =
		list.has_more && last !== undefined
			? encodeKeysetCursor({ at: new Date(last.created * 1000), id: last.id })
			: null;
	const firstPage = request.cursor === undefined ? { facets: null, universeEmpty: list.data.length === 0 } : null;
	return keysetListPage({ rows: list.data.map(toTransaction), nextCursor }, firstPage);
}
