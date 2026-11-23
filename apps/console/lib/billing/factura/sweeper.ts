// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The фактура sweeper (#7369): the scheduled retry for every paid invoice whose фактура is still
// owed, so a transient failure (the ECB rate was not out yet, the store or the object storage
// blinked, the customer has since completed their address) is retried inside the Art. 113(4) ЗДДС
// five-day window without anyone replaying a Stripe event.
//
// ONE PASS (`runFacturaSweep`):
//   1. RETRY. Each invoice mirrored with `factura_status = 'pending'` (lib/billing/invoices.ts wrote
//      it so, and alerted once at the time), oldest payment first, at most `SWEEP_BATCH`: the Stripe
//      invoice is read again and handed to the same issuer the webhook uses (`requestFactura`), which
//      is idempotent: it issues the фактура, or finds the one already issued and renders its PDF.
//      On success the mirror row gets the number and document, exactly the fields the webhook writes,
//      and only while the row is still pending. Its `status` (paid, refunded) is never touched.
//   2. ALERT BY DAY 3. A фактура still owed three days after the payment pages the operator, with
//      the deadline (payment + 5 days) and the reason, and again each day after that until it is
//      issued. The alert is claimed with a compare-and-set on `invoice.factura_alerted_at`, so
//      instances running the sweep at once page once.
//   3. CREDIT-NOTE PDFS. A credit note whose number and snapshot are committed but whose PDF never
//      landed (credit-note.ts: the order of writes) is rendered from its snapshot and attached. A
//      фактура's own PDF is covered by step 1, since an issued-without-PDF фактура leaves its invoice
//      pending.
//
// What it does NOT retry: a refund whose credit note could not be issued because its фактура did not
// exist yet. That needs the refund, which only the Stripe event carries; the credit-note path
// alerted the operator to replay it.
//
// Booted from the reconcile loop (lib/reconcile/loop.ts, every hour) on every instance. Every write
// is idempotent or compare-and-set, so overlapping passes are safe. Server-only.

import { and, asc, eq, isNull, lt, lte, or } from "drizzle-orm";
import type Stripe from "stripe";
import { alertOperator } from "@/lib/billing/operator-alert";
import { getStripe } from "@/lib/billing/stripe";
import { getServiceDb } from "@/lib/db";
import { type Factura, factura, type Invoice, invoice } from "@/lib/db/schema";
import { log } from "@/lib/observability/log";
import { storage } from "@/lib/storage";
import type { FacturaSource } from "./checks";
import { renderFacturaPdf } from "./document";
import { dbFacturaStore, documentFor, type FacturaOutcome, requestFactura } from "./issue";

/** At most this many pending invoices, and this many PDF-less credit notes, per pass. */
export const SWEEP_BATCH = 50;

/** Art. 113(4): the фактура is due within this many days of the chargeable event. */
export const FACTURA_DEADLINE_DAYS = 5;

/** The operator is paged once a фактура has been owed this many days (two days before the deadline). */
export const FACTURA_ALERT_AFTER_DAYS = 3;

/** A repeated page for the same invoice waits at least this long. */
const REALERT_MS = 24 * 60 * 60 * 1000;

/** A PDF-less credit note younger than this may still be rendering in the request that issued it. */
const PDF_GRACE_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The mirror-row fields the sweep reads. */
export type PendingInvoice = Pick<Invoice, "id" | "organizationId" | "stripeInvoiceId" | "stripeCustomerId" | "paidAt">;

/** The document fields a success writes onto the mirror row (the webhook writes the same ones). */
export interface IssuedDocument {
	number: string;
	pdfKey: string;
	hostedInvoiceUrl: string | null;
}

/** The database side of the sweep, so a pass is testable without Postgres. */
export interface SweepStore {
	/** Invoices whose фактура is still owed, oldest payment first. */
	pendingInvoices(limit: number): Promise<PendingInvoice[]>;
	/** Writes the issued document onto the mirror row, only while it is still pending. */
	markIssued(invoiceRowId: string, doc: IssuedDocument): Promise<void>;
	/**
	 * Claims the right to page about this invoice now: true, and `factura_alerted_at` set to `now`,
	 * when it was never paged or last paged before `before`; false when another pass already did.
	 */
	claimAlert(invoiceRowId: string, now: Date, before: Date): Promise<boolean>;
	/** Credit notes with no PDF attached, created before `before`. */
	creditNotesWithoutPdf(before: Date, limit: number): Promise<Factura[]>;
}

/** The Stripe invoice fields a retry reads: the issuer's, and the hosted page kept beside the фактура. */
export type SweepInvoice = FacturaSource & Pick<Stripe.Invoice, "hosted_invoice_url">;

/** The one Stripe call a retry makes, as a structural type the Stripe client satisfies. */
export interface InvoiceReader {
	invoices: { retrieve(id: string): Promise<SweepInvoice> };
}

/** Everything a pass reads from outside, replaceable in tests. */
export interface SweepDeps {
	store: SweepStore;
	stripe: InvoiceReader;
	request: (inv: SweepInvoice, orgId: string) => Promise<FacturaOutcome>;
	document: (row: Factura) => Promise<FacturaOutcome>;
	alert: typeof alertOperator;
}

/** What one pass did (a type alias, so the reconcile loop's heartbeat can record it). */
export type SweepReport = {
	retried: number;
	issued: number;
	alerted: number;
	pdfsRendered: number;
	failures: number;
};

/** The Postgres store, through the service role. */
export const dbSweepStore: SweepStore = {
	async pendingInvoices(limit) {
		return getServiceDb()
			.select({
				id: invoice.id,
				organizationId: invoice.organizationId,
				stripeInvoiceId: invoice.stripeInvoiceId,
				stripeCustomerId: invoice.stripeCustomerId,
				paidAt: invoice.paidAt,
			})
			.from(invoice)
			.where(eq(invoice.facturaStatus, "pending"))
			.orderBy(asc(invoice.paidAt))
			.limit(limit);
	},
	async markIssued(invoiceRowId, doc) {
		await getServiceDb()
			.update(invoice)
			.set({ ...doc, facturaStatus: "issued", updatedAt: new Date() })
			.where(and(eq(invoice.id, invoiceRowId), eq(invoice.facturaStatus, "pending")));
	},
	async claimAlert(invoiceRowId, now, before) {
		const claimed = await getServiceDb()
			.update(invoice)
			.set({ facturaAlertedAt: now })
			.where(
				and(
					eq(invoice.id, invoiceRowId),
					eq(invoice.facturaStatus, "pending"),
					or(isNull(invoice.facturaAlertedAt), lt(invoice.facturaAlertedAt, before)),
				),
			)
			.returning({ id: invoice.id });
		return claimed.length > 0;
	},
	async creditNotesWithoutPdf(before, limit) {
		return getServiceDb()
			.select()
			.from(factura)
			.where(and(eq(factura.kind, "credit_note"), isNull(factura.pdfKey), lte(factura.createdAt, before)))
			.orderBy(asc(factura.createdAt))
			.limit(limit);
	},
};

/** `deps` with each missing dependency filled by its production one (Stripe only when needed). */
function withDefaults(deps: Partial<SweepDeps>): SweepDeps {
	return {
		store: deps.store ?? dbSweepStore,
		stripe: deps.stripe ?? getStripe(),
		request: deps.request ?? ((inv, orgId) => requestFactura(inv, orgId)),
		document:
			deps.document ??
			((row) => documentFor(row, { store: dbFacturaStore, pdfStorage: storage, render: renderFacturaPdf })),
		alert: deps.alert ?? alertOperator,
	};
}

/** YYYY-MM-DD (UTC) of `d`. */
function day(d: Date): string {
	return d.toISOString().slice(0, 10);
}

/** Pages the operator: the фактура for `row` is still owed, why, and by when. */
async function alertOwed(row: PendingInvoice, paidAt: Date, why: string, deps: SweepDeps): Promise<void> {
	const due = new Date(paidAt.getTime() + FACTURA_DEADLINE_DAYS * DAY_MS);
	await deps.alert({
		title: "A фактура is near its Art. 113(4) deadline",
		subject: { type: "stripe_customer", id: row.stripeCustomerId ?? row.stripeInvoiceId },
		summary:
			`Stripe invoice ${row.stripeInvoiceId} (organization ${row.organizationId}) was paid on ${day(paidAt)} ` +
			`and still has no compliant фактура after the sweeper retried it: ${why}. ` +
			`Art. 113(4) ЗДДС deadline: ${day(due)}. Fix the cause; the sweeper retries every hour.`,
	});
}

/**
 * One sweep pass at `now`: retries every owed фактура, pages the operator for those owed three
 * days or more, and renders missing credit-note PDFs. Never throws for one document; a database
 * read that fails throws, so the reconcile loop records the pass as failed.
 */
export async function runFacturaSweep(now: Date = new Date(), deps: Partial<SweepDeps> = {}): Promise<SweepReport> {
	const all = withDefaults(deps);
	const report: SweepReport = { retried: 0, issued: 0, alerted: 0, pdfsRendered: 0, failures: 0 };

	for (const row of await all.store.pendingInvoices(SWEEP_BATCH)) {
		report.retried++;
		let why: string;
		try {
			const inv = await all.stripe.invoices.retrieve(row.stripeInvoiceId);
			const outcome = await all.request(inv, row.organizationId);
			if (outcome.ok) {
				await all.store.markIssued(row.id, {
					number: outcome.factura.number,
					pdfKey: outcome.factura.pdfKey,
					hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
				});
				report.issued++;
				continue;
			}
			why = `${outcome.reason} — ${outcome.detail}`;
		} catch (err) {
			log.error("[factura] sweep retry failed", { err, invoice: row.stripeInvoiceId });
			why = "the retry itself failed (Stripe or the database); see the console log";
		}
		report.failures++;
		const paidAt = row.paidAt ?? now;
		if (now.getTime() - paidAt.getTime() < FACTURA_ALERT_AFTER_DAYS * DAY_MS) continue;
		if (await all.store.claimAlert(row.id, now, new Date(now.getTime() - REALERT_MS))) {
			await alertOwed(row, paidAt, why, all);
			report.alerted++;
		}
	}

	for (const note of await all.store.creditNotesWithoutPdf(new Date(now.getTime() - PDF_GRACE_MS), SWEEP_BATCH)) {
		const outcome = await all.document(note).catch((err: unknown): FacturaOutcome => {
			log.error("[factura] sweep credit-note render failed", { err, number: note.number });
			return { ok: false, reason: "pdf_failed", detail: "render threw" };
		});
		if (outcome.ok) report.pdfsRendered++;
		else report.failures++;
	}

	if (report.retried || report.pdfsRendered || report.failures) log.info("[factura] sweep pass", { ...report });
	return report;
}
