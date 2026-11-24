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
// TWO SOURCES, ONE CONTRACT. Invoices are our own table, so they page in SQL through the shared
// codec: ordered by the display date (`paid_at`, falling back to `created_at`, which is exactly
// what `InvoiceInfo.paidAt` shows) truncated to ms, then the id. Charges live in Stripe, which owns
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
import { type Invoice, invoice } from "@/lib/db/schema";
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

// ── Invoices (our mirrored table) ───────────────────────────────────────────────────────────────

/** The invoices list's facets: status options counted over the org's UNFILTERED invoices. */
export interface InvoiceFacets {
	status: FacetOption[];
}

/** The invoice filters a page applies — the reader's filters without the retired `limit`. */
export type InvoicePageFilters = Omit<InvoiceListFilters, "limit">;

/**
 * The instant an invoice is listed under: when it was paid, or when we mirrored it if Stripe never
 * told us (a row from before `paid_at` was captured). The same fallback `InvoiceInfo.paidAt`
 * renders, so the order the list walks is the order the "Paid" column reads.
 */
const INVOICE_LISTED_AT: SQL = keysetSortKey(sql`coalesce(${invoice.paidAt}, ${invoice.createdAt})`);

/** A row's keyset position, by the same fallback as {@link INVOICE_LISTED_AT}. */
function invoiceKey(row: Invoice): { at: Date; id: string } {
	return { at: row.paidAt ?? row.createdAt, id: row.id };
}

/**
 * The first page's extras: the status facet over the org's UNFILTERED invoices (only the scope
 * predicate — an option must not vanish the moment it is picked), and whether the org has any
 * invoice at all. One grouped pass answers both; `universeEmpty` stays a boolean.
 */
async function invoiceFirstPage(orgId: string): Promise<{ facets: InvoiceFacets; universeEmpty: boolean }> {
	const counts = await getServiceDb()
		.select({ status: invoice.status, n: count() })
		.from(invoice)
		.where(eq(invoice.organizationId, orgId))
		.groupBy(invoice.status);
	return {
		facets: { status: counts.map((c) => ({ value: c.status, label: null, count: c.n })) },
		universeEmpty: counts.every((c) => c.n === 0),
	};
}

/**
 * One page of an org's mirrored invoices, newest first. `orgId` is the resolved actor's (never
 * user input); the filters narrow the ROWS pass only. Facets and `universeEmpty` come with the
 * first page (no cursor) and are null after it.
 */
export async function queryInvoicesPage(
	orgId: string,
	filters: InvoicePageFilters,
	request: KeysetPageRequest,
): Promise<KeysetListPage<Invoice, InvoiceFacets>> {
	const where: (SQL | undefined)[] = [eq(invoice.organizationId, orgId)];
	if (filters.status?.length) where.push(inArray(invoice.status, filters.status));
	if (filters.paidFrom) where.push(gte(invoice.paidAt, new Date(filters.paidFrom)));
	if (filters.paidTo) where.push(lte(invoice.paidAt, new Date(filters.paidTo)));
	where.push(keysetAfter(INVOICE_LISTED_AT, invoice.id, request.cursor));

	const fetched = await getServiceDb()
		.select()
		.from(invoice)
		.where(and(...where))
		.orderBy(...keysetOrderBy(INVOICE_LISTED_AT, invoice.id))
		.limit(keysetFetchLimit(request.limit));
	const page = keysetPage(fetched, request.limit, invoiceKey);
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
