// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The seam's `listDocuments` for Paddle (L5), and the invoice-PDF lookup behind the invoices page's
// download link. Paddle is the merchant of record, so the customer's invoice is PADDLE's document:
// we list the org's billed/completed transactions from `GET /transactions` and hand out Paddle's
// own invoice PDF (`GET /transactions/{id}/invoice`) when the customer opens one.
//
// OWNERSHIP IS DECIDED HERE, NOT BY PADDLE'S FILTER. A Paddle customer is one e-mail address, and
// one customer can own businesses for several of our organizations, so `customer_id` alone would
// list another org's invoices. A transaction is the org's only when one of these holds:
//   · its `subscription_id` is one the org's billing row holds (plan or AI slot);
//   · it is in the org's own transaction mirror (`paddle_transaction`, written by the webhook with
//     the org it resolved — this covers credit packs and subscriptions the org has since replaced);
//   · it is the org's Paddle customer's AND its `custom_data.organizationId` is the org (a checkout
//     we created for it — custom_data alone is untrusted, so it never decides without the customer).
// The PDF lookup applies the same test to the one transaction asked for, so a guessed `txn_…` id
// from another org answers "not found".
//
// The PDF URL is not listed: Paddle signs it for a short time, so it is fetched when the customer
// clicks (`paddleInvoicePdfUrl`), never stored or put in a page. Server-only.

import { money } from "@repo/format";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { PaddleApiError, type PaddleClient, paddleClient } from "@/lib/billing/paddle/api";
import type { BillingDocument } from "@/lib/billing/provider/types";
import { getServiceDb } from "@/lib/db";
import { organizationBilling, paddleTransaction } from "@/lib/db/schema";

/** The default and the largest number of documents one call returns. */
export const DOCUMENTS_DEFAULT_LIMIT = 50;
export const DOCUMENTS_MAX_LIMIT = 200;

/** Paddle's page size for `GET /transactions` (its maximum). */
export const PADDLE_TRANSACTIONS_PAGE_SIZE = 30;

/** A hard stop on pages read per call, so a customer with a long history cannot stall a page load. */
export const DOCUMENTS_MAX_PAGES = 10;

const isoDate = z
	.string()
	.refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 timestamp")
	.transform((s) => new Date(s));

const minorAmount = z
	.string()
	.regex(/^-?\d{1,15}$/, "must be an integer amount in minor units")
	.transform(Number);

/** The transaction fields a document is built from. */
export const documentTransactionSchema = z.looseObject({
	id: z.string().startsWith("txn_"),
	status: z.string(),
	subscription_id: z.string().nullish(),
	customer_id: z.string().nullish(),
	invoice_number: z.string().nullish(),
	currency_code: z.string().length(3),
	billed_at: isoDate.nullish(),
	billing_period: z.object({ starts_at: isoDate, ends_at: isoDate }).nullish(),
	custom_data: z.unknown().optional(),
	details: z.looseObject({ totals: z.looseObject({ total: minorAmount }) }),
});

export type DocumentTransaction = z.infer<typeof documentTransactionSchema>;

const invoiceUrlSchema = z.looseObject({ url: z.url({ protocol: /^https$/ }) });

const orgMarker = z.looseObject({ organizationId: z.string() });

/** What decides which of a customer's transactions belong to one org. */
export interface OrgPaddleOwnership {
	organizationId: string;
	customerId: string | null;
	subscriptionIds: ReadonlySet<string>;
	mirroredTransactionIds: ReadonlySet<string>;
}

/** Whether a transaction belongs to the org (see the header). */
export function ownsTransaction(own: OrgPaddleOwnership, txn: DocumentTransaction): boolean {
	if (txn.subscription_id && own.subscriptionIds.has(txn.subscription_id)) return true;
	if (own.mirroredTransactionIds.has(txn.id)) return true;
	// custom_data is untrusted (a client-opened checkout can carry any), so it counts only on a
	// transaction of the org's own Paddle customer.
	if (!own.customerId || txn.customer_id !== own.customerId) return false;
	const marker = orgMarker.safeParse(txn.custom_data);
	return marker.success && marker.data.organizationId === own.organizationId;
}

/** A transaction as a billing document. */
export function toBillingDocument(txn: DocumentTransaction): BillingDocument {
	return {
		id: txn.id,
		kind: "invoice",
		number: txn.invoice_number ?? null,
		issuedAt: txn.billed_at ?? null,
		total: money(txn.details.totals.total, txn.currency_code.toLowerCase()),
		url: null,
		issuer: "paddle",
		periodStart: txn.billing_period?.starts_at ?? null,
		periodEnd: txn.billing_period?.ends_at ?? null,
	};
}

/** Everything the document reads need, injectable for tests. */
export interface PaddleDocumentDeps {
	client: () => PaddleClient;
	ownership: (organizationId: string) => Promise<OrgPaddleOwnership>;
}

/** Reads the org's ownership facts from its billing row and its transaction mirror. */
export async function loadOrgPaddleOwnership(organizationId: string): Promise<OrgPaddleOwnership> {
	const db = getServiceDb();
	const [row] = await db
		.select({
			customerId: organizationBilling.paddleCustomerId,
			plan: organizationBilling.paddleSubscriptionId,
			ai: organizationBilling.aiPaddleSubscriptionId,
		})
		.from(organizationBilling)
		.where(eq(organizationBilling.organizationId, organizationId))
		.limit(1);
	const mirrored = await db
		.select({ id: paddleTransaction.paddleTransactionId })
		.from(paddleTransaction)
		.where(eq(paddleTransaction.organizationId, organizationId));
	const subs = new Set<string>();
	if (row?.plan) subs.add(row.plan);
	if (row?.ai) subs.add(row.ai);
	return {
		organizationId,
		customerId: row?.customerId ?? null,
		subscriptionIds: subs,
		mirroredTransactionIds: new Set(mirrored.map((m) => m.id)),
	};
}

const defaultDeps: PaddleDocumentDeps = { client: paddleClient, ownership: loadOrgPaddleOwnership };

/**
 * The org's Paddle invoices (billed and completed transactions), newest first, at most `limit`.
 * Pages through `GET /transactions?customer_id=…` with Paddle's `after` cursor, keeping only the
 * org's own transactions. An org with no Paddle customer has none. Throws `PaddleApiError` when
 * Paddle cannot be read — an error, never an empty list that would read as "no invoices".
 */
export async function listPaddleDocuments(
	organizationId: string,
	opts: { limit?: number } = {},
	deps: PaddleDocumentDeps = defaultDeps,
): Promise<BillingDocument[]> {
	const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DOCUMENTS_DEFAULT_LIMIT)), DOCUMENTS_MAX_LIMIT);
	const own = await deps.ownership(organizationId);
	if (!own.customerId) return [];
	const client = deps.client();

	const docs: BillingDocument[] = [];
	let after: string | undefined;
	for (let page = 0; page < DOCUMENTS_MAX_PAGES && docs.length < limit; page++) {
		const txns = await client.request(
			{
				method: "GET",
				path: "/transactions",
				query: {
					customer_id: own.customerId,
					status: "billed,completed",
					order_by: "id[DESC]",
					per_page: PADDLE_TRANSACTIONS_PAGE_SIZE,
					after,
				},
			},
			z.array(documentTransactionSchema),
		);
		for (const txn of txns) {
			if (docs.length >= limit) break;
			if (ownsTransaction(own, txn)) docs.push(toBillingDocument(txn));
		}
		const last = txns.at(-1);
		if (!last || txns.length < PADDLE_TRANSACTIONS_PAGE_SIZE) break;
		after = last.id;
	}
	return docs;
}

/** Whether a Paddle error says the thing does not exist (or is not ours to see). */
function isNotFound(err: unknown): boolean {
	return err instanceof PaddleApiError && err.kind === "http" && (err.status === 404 || err.status === 403);
}

/**
 * A short-lived URL to Paddle's invoice PDF for one of the org's transactions; null when the
 * transaction does not exist, is not the org's, or has no invoice yet. `attachment` makes the
 * browser download it; `inline` lets the preview show it.
 */
export async function paddleInvoicePdfUrl(
	organizationId: string,
	transactionId: string,
	disposition: "attachment" | "inline",
	deps: PaddleDocumentDeps = defaultDeps,
): Promise<string | null> {
	if (!/^txn_[a-z0-9]+$/.test(transactionId)) return null;
	const own = await deps.ownership(organizationId);
	const client = deps.client();
	try {
		const txn = await client.request(
			{ method: "GET", path: `/transactions/${transactionId}` },
			documentTransactionSchema,
		);
		if (!ownsTransaction(own, txn)) return null;
		if (txn.status !== "billed" && txn.status !== "completed") return null;
		const invoice = await client.request(
			{ method: "GET", path: `/transactions/${transactionId}/invoice`, query: { disposition } },
			invoiceUrlSchema,
		);
		return invoice.url;
	} catch (err) {
		if (isNotFound(err)) return null;
		throw err;
	}
}
