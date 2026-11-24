// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Issues the credit note (кредитно известие, Art. 115 ЗДДС) for a Stripe refund (#7369). A full or a
// partial refund of a paid invoice reduces the tax base of the фактура issued for it, and the
// document of that reduction is a credit note in the SAME ten-digit series, naming the фактура it
// corrects by number and date (Art. 115(3)).
//
// WHAT IS PRINTED, and where each part comes from:
//  - supplier and recipient: copied from the original фактура's snapshot, never re-read from Stripe,
//    so the credit note names exactly the parties the фактура named;
//  - the lines: a full refund negates every line of the фактура; a partial one is a single line for
//    the refunded amount, naming the фактура it is against;
//  - the amounts: negative, the refunded amount (Stripe refunds in the charge's currency, which is
//    the invoice's); VAT 0 with the same no-VAT ground as the фактура;
//  - the EUR equivalent of a non-EUR credit note (Art. 114(5)): at the ORIGINAL фактура's recorded
//    rate, so a full refund nets the EUR amounts to exactly zero. Whether the accountant wants the
//    rate of the refund date instead is an open question recorded on the PR;
//  - the chargeable date: the day of the refund in Sofia (the event that changed the tax base).
//
// IDEMPOTENT per refund: the row is unique on (Stripe invoice, kind, refund id), so a replay of
// `charge.refunded`, the later `charge.refund.updated`, and a racing instance all converge on one
// credit note per refund. The order of writes is the фактура's (issue.ts): every check before a
// number is taken; number and snapshot in one transaction; the PDF after, re-rendered by the sweeper
// (sweeper.ts) when that step failed.
//
// It never throws for a refund it cannot document; the outcome names why, and the webhook caller
// alerts the operator. Server-only.

import { and, eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { type InvoicePaymentLookup, invoiceIdOfPaymentIntent } from "@/lib/billing/invoice-facts";
import { alertOperator } from "@/lib/billing/operator-alert";
import { getServiceDb } from "@/lib/db";
import { type Factura, factura } from "@/lib/db/schema";
import { log } from "@/lib/observability/log";
import { storage } from "@/lib/storage";
import type { FacturaSnapshot } from "@/types/jsonb.types";
import { isLegalInvoiceNumber } from "./checks";
import { buildCreditNoteSnapshot } from "./credit-note-snapshot";
import { renderFacturaPdf } from "./document";
import {
	dbFacturaStore,
	documentFor,
	type FacturaOutcome,
	type FacturaPdfStorage,
	type FacturaStore,
	type IssuedFactura,
	sofiaDay,
} from "./issue";


/** The Stripe refund fields a credit note is built from (a full `Stripe.Refund` satisfies it). */
export type RefundSource = Pick<Stripe.Refund, "id" | "amount" | "currency" | "created" | "status">;

/**
 * Why no credit note exists for a refund.
 *  - `refund_not_succeeded`: the refund has not (yet) moved money; a later event issues it.
 *  - `no_original`: no фактура was issued for the refunded invoice, so there is nothing to correct.
 *    Issue the фактура first (the sweeper retries it), then replay the refund event.
 *  - `currency_mismatch`: the refund's currency is not the фактура's.
 *  - `over_credit`: the credit notes would add up to more than the фактура.
 *  - `store_failed`, `pdf_failed`, `pdf_integrity`: as for a фактура (checks.ts).
 */
export type CreditNoteFailure =
	| "refund_not_succeeded"
	| "no_original"
	| "currency_mismatch"
	| "over_credit"
	| "store_failed"
	| "pdf_failed"
	| "pdf_integrity";

/** The result of asking for a credit note: the issued document, or why there is none. */
export type CreditNoteOutcome =
	| { ok: true; creditNote: IssuedFactura }
	| { ok: false; reason: CreditNoteFailure; detail: string };

/** The database side of issuing a credit note. */
export interface CreditNoteStore extends Pick<FacturaStore, "issue" | "attachPdf" | "findIssued"> {
	/** The credit note already issued for a Stripe refund, or null. */
	findCreditNote(stripeRefundId: string): Promise<Factura | null>;
	/** The sum, as a positive amount in minor units, of the credit notes issued against a фактура. */
	creditedMinor(originalFacturaId: string): Promise<number>;
}

/** Everything `requestCreditNote` reads from outside, replaceable in tests. */
export interface CreditNoteDeps {
	store: CreditNoteStore;
	pdfStorage: FacturaPdfStorage;
	render: typeof renderFacturaPdf;
	now: () => Date;
}

/** The Postgres store, through the service role. */
export const dbCreditNoteStore: CreditNoteStore = {
	findIssued: dbFacturaStore.findIssued,
	issue: dbFacturaStore.issue,
	attachPdf: dbFacturaStore.attachPdf,
	async findCreditNote(stripeRefundId) {
		const [row] = await getServiceDb()
			.select()
			.from(factura)
			.where(and(eq(factura.stripeRefundId, stripeRefundId), eq(factura.kind, "credit_note")))
			.limit(1);
		return row ?? null;
	},
	async creditedMinor(originalFacturaId) {
		const [row] = await getServiceDb()
			.select({ total: sql<string>`coalesce(sum(-(${factura.snapshot}->>'totalMinor')::bigint), 0)` })
			.from(factura)
			.where(and(eq(factura.originalFacturaId, originalFacturaId), eq(factura.kind, "credit_note")));
		return Number(row?.total ?? 0);
	},
};

/** The production dependencies. */
const defaultDeps: CreditNoteDeps = {
	store: dbCreditNoteStore,
	pdfStorage: storage,
	render: renderFacturaPdf,
	now: () => new Date(),
};


/** A failed outcome. */
function fail(reason: CreditNoteFailure, detail: string): CreditNoteOutcome {
	return { ok: false, reason, detail };
}

/** A фактура outcome (from `documentFor`) as a credit-note outcome. */
function asCreditNote(outcome: FacturaOutcome): CreditNoteOutcome {
	if (outcome.ok) return { ok: true, creditNote: outcome.factura };
	const reason: CreditNoteFailure = outcome.reason === "pdf_integrity" ? "pdf_integrity" : outcome.reason === "pdf_failed" ? "pdf_failed" : "store_failed";
	return fail(reason, outcome.detail);
}

/** Issues (or finds) the credit note for one refund. The body of `requestCreditNote`. */
async function issueFor(stripeInvoiceId: string, refund: RefundSource, deps: CreditNoteDeps): Promise<CreditNoteOutcome> {
	if (refund.status !== "succeeded") {
		return fail("refund_not_succeeded", `refund ${refund.id} is ${refund.status ?? "of unknown status"}, not succeeded`);
	}
	const existing = await deps.store.findCreditNote(refund.id);
	if (existing) return asCreditNote(await documentFor(existing, deps));

	const original = await deps.store.findIssued(stripeInvoiceId);
	if (!original) {
		return fail(
			"no_original",
			`no фактура was issued for Stripe invoice ${stripeInvoiceId}, so refund ${refund.id} has nothing to correct`,
		);
	}
	const currency = refund.currency.toUpperCase();
	if (currency !== original.snapshot.currency) {
		return fail(
			"currency_mismatch",
			`refund ${refund.id} is in ${currency} but фактура ${original.number} is in ${original.snapshot.currency}`,
		);
	}
	const credited = await deps.store.creditedMinor(original.id);
	if (refund.amount <= 0 || credited + refund.amount > original.snapshot.totalMinor) {
		return fail(
			"over_credit",
			`refund ${refund.id} of ${refund.amount} would credit фактура ${original.number} beyond its total ` +
				`(${original.snapshot.totalMinor}, already credited ${credited})`,
		);
	}

	const chargeableDate = sofiaDay(new Date(refund.created * 1000));
	const issueDate = sofiaDay(deps.now());
	const row =
		(await deps.store.issue((number) => ({
			organizationId: original.organizationId,
			number,
			kind: "credit_note",
			originalFacturaId: original.id,
			stripeInvoiceId,
			stripeRefundId: refund.id,
			issueDate,
			chargeableDate,
			snapshot: buildCreditNoteSnapshot(original.snapshot, refund.amount, { number, issueDate, chargeableDate }),
		}))) ?? (await deps.store.findCreditNote(refund.id));
	if (!row || !isLegalInvoiceNumber(row.number)) {
		return fail("store_failed", "the issued credit note could not be read back");
	}
	return asCreditNote(await documentFor(row, deps));
}

/**
 * The credit note of Stripe refund `refund` against Stripe invoice `stripeInvoiceId`: issued now, or
 * found when it was issued before. Never throws; a failure names its reason.
 */
export async function requestCreditNote(
	stripeInvoiceId: string,
	refund: RefundSource,
	deps: Partial<CreditNoteDeps> = {},
): Promise<CreditNoteOutcome> {
	const all: CreditNoteDeps = { ...defaultDeps, ...deps };
	try {
		return await issueFor(stripeInvoiceId, refund, all);
	} catch (err) {
		log.error("[factura] credit note failed", { err, refund: refund.id, invoice: stripeInvoiceId });
		return fail("store_failed", "the number and credit note could not be saved; nothing was issued");
	}
}

/**
 * The Stripe calls the refund path makes, as a structural type: the Stripe client satisfies it, and
 * so does a test double that implements only these two list calls.
 */
export interface RefundReader extends InvoicePaymentLookup {
	refunds: { list(params: { charge: string; limit: number }): Promise<{ data: RefundSource[] }> };
}

/** Failures a redelivery of the Stripe event can fix: the webhook throws on them so Stripe retries. */
const TRANSIENT: ReadonlySet<CreditNoteFailure> = new Set(["store_failed"]);

/** Tells the operator a refund has no credit note, why, and what to do. */
async function alertCreditNoteMissing(
	stripeInvoiceId: string,
	refund: RefundSource,
	failure: Extract<CreditNoteOutcome, { ok: false }>,
): Promise<void> {
	await alertOperator({
		title: "A Stripe refund has no credit note",
		subject: { type: "stripe_customer", id: `refund:${refund.id}` },
		summary:
			`Refund ${refund.id} of Stripe invoice ${stripeInvoiceId} has no credit note (кредитно известие): ` +
			`${failure.reason} — ${failure.detail}. Fix the cause, then replay its charge.refunded event ` +
			`(break-glass replay_webhook). Art. 115 ЗДДС gives five days from the refund.`,
	});
}

/**
 * Issues a credit note for every succeeded refund of a charge (the `charge.refunded` event): one per
 * refund, so a second partial refund issues a second credit note and a replay issues none. A refund
 * that cannot be documented alerts the operator; a store failure throws after the others are tried,
 * so the event fails and Stripe redelivers it. A Stripe read error throws too. Returns the outcomes.
 */
export async function issueCreditNotesForCharge(
	charge: Pick<Stripe.Charge, "id" | "payment_intent">,
	stripe: RefundReader,
	deps: Partial<CreditNoteDeps> = {},
): Promise<CreditNoteOutcome[]> {
	const stripeInvoiceId = await invoiceIdOfPaymentIntent(charge.payment_intent, stripe);
	if (!stripeInvoiceId) return [];
	const refunds = await stripe.refunds.list({ charge: charge.id, limit: 100 });
	return settle(stripeInvoiceId, refunds.data.filter((r) => r.status === "succeeded"), deps);
}

/**
 * Issues the credit note for one refund that has just succeeded (the `charge.refund.updated` event:
 * a refund that was pending when `charge.refunded` fired). No-op for a refund that has not succeeded
 * or names no paid invoice. Throws as `issueCreditNotesForCharge` does.
 */
export async function issueCreditNoteForRefund(
	refund: RefundSource & Pick<Stripe.Refund, "payment_intent">,
	stripe: RefundReader,
	deps: Partial<CreditNoteDeps> = {},
): Promise<CreditNoteOutcome[]> {
	if (refund.status !== "succeeded") return [];
	const stripeInvoiceId = await invoiceIdOfPaymentIntent(refund.payment_intent, stripe);
	if (!stripeInvoiceId) return [];
	return settle(stripeInvoiceId, [refund], deps);
}

/** Requests each refund's credit note in order, alerts on each failure, and throws on a transient one. */
async function settle(
	stripeInvoiceId: string,
	refunds: RefundSource[],
	deps: Partial<CreditNoteDeps>,
): Promise<CreditNoteOutcome[]> {
	const outcomes: CreditNoteOutcome[] = [];
	// Oldest refund first, so credit-note numbers follow the order the refunds happened in.
	for (const refund of [...refunds].sort((a, b) => a.created - b.created)) {
		const outcome = await requestCreditNote(stripeInvoiceId, refund, deps);
		if (!outcome.ok) await alertCreditNoteMissing(stripeInvoiceId, refund, outcome);
		outcomes.push(outcome);
	}
	const transient = outcomes.find((o) => !o.ok && TRANSIENT.has(o.reason));
	if (transient && !transient.ok) {
		throw new Error(`credit note for Stripe invoice ${stripeInvoiceId}: ${transient.reason} — ${transient.detail}`);
	}
	return outcomes;
}
