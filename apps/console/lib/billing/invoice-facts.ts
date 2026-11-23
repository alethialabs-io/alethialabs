// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The per-invoice tax facts and the running totals the tax thresholds read (#7327, EA-5).
//
// THE SNAPSHOT. When an invoice is paid, the webhook mirrors it (lib/billing/invoices.ts) and then
// calls `recordInvoiceFacts`, which writes onto that row the buyer AS DECLARED AT THAT MOMENT — the
// country, US state, capacity and VAT-number status from `organization_billing` — plus the total in
// euro cents with the rate and its source. It is written ONCE: a replay never re-describes a past
// sale with a later declaration. The one thing a replay may add is a EUR amount that could not be
// converted the first time.
//
// THE RATE. An EUR invoice needs none (rate 1, source `EUR`). Any other is converted at the European
// Central Bank's reference rate for the latest publication date on or before the payment date
// (source `ECB:<date>`). Which rate the law requires (BNB or ECB, on which date) is NOT established
// (spec §4 risk 3), so the rate and its source are recorded beside the amount and the choice can be
// audited and re-run. When no rate can be had, the EUR amount stays NULL and every total that
// invoice counts toward reads UNREADABLE (fail-closed, see @repo/legal/turnover), and the operator
// is told to replay the event.
//
// REFUNDS AND VOIDS. `invoice.voided` and a FULL refund (`charge.refunded` with `refunded: true`)
// change the row's status, and only `paid` rows count. A partial refund is not recorded, so the
// totals read high — which stops a sale early rather than late.
//
// THE TOTALS AND THE GATE. `readTurnoverTotals` sums the rows with `@repo/legal/turnover`, the same
// function the admin `/turnover` page calls. EA-2's gate (lib/billing/turnover.ts) calls
// `assessSaleBeforeCharge` BEFORE it takes a sale: the sale that crosses the EU EUR 10,000 is itself
// taxed in the buyer's member state (TAX §3.5), so refusing it afterwards is too late.
//
// THE ALERTS. Recording runs under one transaction-scoped advisory lock, and compares the totals
// without and with the invoice. A threshold that rises to `warn` (default 80%) or to `stop` alerts
// the operator once — exactly the invoice that made it rise sees the rise, because no other
// recording can interleave.

import type { PayerCapacity } from "@repo/legal/commerce";
import { DEFAULT_WARN_MARGIN, thresholdCountersForSale } from "@repo/legal/thresholds";
import {
	assessSaleAgainstTurnover,
	assessTurnover,
	type ProspectiveSale,
	type SaleAssessment,
	type ThresholdEscalation,
	type TurnoverFact,
	type TurnoverTotals,
	thresholdEscalations,
	turnoverTotals,
	turnoverWindowStart,
} from "@repo/legal/turnover";
import { eq, gte, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { setInvoiceStatus } from "@/lib/billing/invoices";
import { alertOperator } from "@/lib/billing/operator-alert";
import { getServiceDb } from "@/lib/db";
import { invoice, organizationBilling } from "@/lib/db/schema";
import { log } from "@/lib/observability/log";
import { ecbEurRate, type EurRateLookup, toEurMinor } from "@/lib/billing/ecb-rate";

// ── The store ───────────────────────────────────────────────────────────────────────────────────

/** What the organization had declared about its buyer facts, read at payment. */
export interface PayerDeclaration {
	readonly country: string | null;
	readonly state: string | null;
	readonly capacity: PayerCapacity | null;
	/** `given` | `not_given`, or null when undeclared. */
	readonly vatIdStatus: string | null;
}

/** An invoice row, with its id, as the recording reads it. */
export interface InvoiceFactRow extends TurnoverFact {
	readonly id: string;
	readonly eurRateSource: string | null;
}

/** The snapshot written onto an invoice row. Absent keys are left unchanged. */
export interface InvoiceSnapshotPatch {
	customerCountry?: string | null;
	customerState?: string | null;
	payerCapacity?: PayerCapacity | null;
	vatIdGiven?: boolean | null;
	amountEurMinor?: number;
	eurRate?: string;
	eurRateSource?: string;
}

/** The reads and writes inside the recording's lock. */
export interface InvoiceFactsTx {
	/** The mirrored row for a Stripe invoice id, or null when it was never mirrored. */
	invoiceRow(stripeInvoiceId: string): Promise<InvoiceFactRow | null>;
	/** Every invoice row paid at or after `since`. */
	factsSince(since: Date): Promise<InvoiceFactRow[]>;
	/** Writes the snapshot onto the row `id`. */
	writeSnapshot(id: string, patch: InvoiceSnapshotPatch): Promise<void>;
}

/** Everything the recording and the totals touch: the live database unless a test injects one. */
export interface InvoiceFactsStore {
	declaration(orgId: string): Promise<PayerDeclaration | null>;
	/** Runs `fn` in one transaction holding the turnover advisory lock. */
	locked<T>(fn: (tx: InvoiceFactsTx) => Promise<T>): Promise<T>;
	/** Every invoice row paid at or after `since`, outside any lock (the gate's read). */
	factsSince(since: Date): Promise<InvoiceFactRow[]>;
}

/** The invoice columns the facts read, selected once. */
const FACT_COLUMNS = {
	id: invoice.id,
	status: invoice.status,
	paidAt: invoice.paidAt,
	currency: invoice.currency,
	amountMinor: invoice.amountTotal,
	amountEurMinor: invoice.amountEurMinor,
	country: invoice.customerCountry,
	state: invoice.customerState,
	capacity: invoice.payerCapacity,
	vatIdGiven: invoice.vatIdGiven,
	eurRateSource: invoice.eurRateSource,
};

/** The one lock every recording takes, so two invoices never assess the same totals at once. */
const TURNOVER_LOCK = sql`select pg_advisory_xact_lock(hashtextextended('billing:turnover', 0))`;

/** The live store over `getServiceDb()`. */
const liveInvoiceFactsStore: InvoiceFactsStore = {
	async declaration(orgId) {
		const [row] = await getServiceDb()
			.select({
				country: organizationBilling.billingCountry,
				state: organizationBilling.billingState,
				capacity: organizationBilling.payerCapacity,
				vatIdStatus: organizationBilling.vatIdStatus,
			})
			.from(organizationBilling)
			.where(eq(organizationBilling.organizationId, orgId))
			.limit(1);
		return row ?? null;
	},
	async locked(fn) {
		return getServiceDb().transaction(async (tx) => {
			await tx.execute(TURNOVER_LOCK);
			return fn({
				async invoiceRow(stripeInvoiceId) {
					const [row] = await tx
						.select(FACT_COLUMNS)
						.from(invoice)
						.where(eq(invoice.stripeInvoiceId, stripeInvoiceId))
						.limit(1);
					return row ?? null;
				},
				async factsSince(since) {
					return tx.select(FACT_COLUMNS).from(invoice).where(gte(invoice.paidAt, since));
				},
				async writeSnapshot(id, patch) {
					await tx
						.update(invoice)
						.set({ ...patch, updatedAt: new Date() })
						.where(eq(invoice.id, id));
				},
			});
		});
	},
	async factsSince(since) {
		return getServiceDb().select(FACT_COLUMNS).from(invoice).where(gte(invoice.paidAt, since));
	},
};

// ── Recording one invoice ───────────────────────────────────────────────────────────────────────

/** Whether a row already carries a snapshot (any of its facts was written). */
function hasSnapshot(row: InvoiceFactRow): boolean {
	return (
		row.country !== null ||
		row.state !== null ||
		row.capacity !== null ||
		row.vatIdGiven !== null ||
		row.eurRateSource !== null
	);
}

/** The snapshot of the buyer as declared, normalised the way the totals read it. */
function snapshotOf(declaration: PayerDeclaration | null): InvoiceSnapshotPatch {
	const country = declaration?.country?.trim().toUpperCase() || null;
	const state = declaration?.state?.trim().toUpperCase() || null;
	const vat = declaration?.vatIdStatus;
	return {
		customerCountry: country,
		customerState: country === "US" ? state : null,
		payerCapacity: declaration?.capacity ?? null,
		vatIdGiven: vat === "given" ? true : vat === "not_given" ? false : null,
	};
}

/** A row with a patch applied, as the totals will read it after the write. */
function applied(row: InvoiceFactRow, patch: InvoiceSnapshotPatch): InvoiceFactRow {
	return {
		...row,
		country: patch.customerCountry !== undefined ? patch.customerCountry : row.country,
		state: patch.customerState !== undefined ? patch.customerState : row.state,
		capacity: patch.payerCapacity !== undefined ? patch.payerCapacity : row.capacity,
		vatIdGiven: patch.vatIdGiven !== undefined ? patch.vatIdGiven : row.vatIdGiven,
		amountEurMinor: patch.amountEurMinor ?? row.amountEurMinor,
		eurRateSource: patch.eurRateSource ?? row.eurRateSource,
	};
}

/** What recording one invoice did. */
export type RecordFactsResult =
	| { readonly recorded: false; readonly reason: "no_invoice_id" | "not_mirrored" | "already_recorded" }
	| {
			readonly recorded: true;
			/** True when the snapshot was written now; false when only a missing EUR amount was filled. */
			readonly snapshot: boolean;
			readonly eurConverted: boolean;
			readonly escalations: readonly ThresholdEscalation[];
	  };

/** Options for `recordInvoiceFacts`; the live store and ECB lookup unless a test injects them. */
export interface RecordFactsOptions {
	store?: InvoiceFactsStore;
	eurRate?: EurRateLookup;
	now?: () => Date;
	warnMargin?: number;
}

/** The payment time Stripe recorded, or now. */
function paidAtOf(inv: Stripe.Invoice, now: Date): Date {
	const paid = inv.status_transitions?.paid_at;
	return paid ? new Date(paid * 1000) : now;
}

/** A usage fraction as a percentage a person reads; "unreadable" for an unreadable total. */
function percent(usage: number): string {
	return Number.isFinite(usage) ? `${Math.round(usage * 100)}%` : "unreadable";
}

/** Tells the operator that a threshold rose to `warn` or `stop`, keyed on the threshold. */
async function alertEscalation(e: ThresholdEscalation, stripeInvoiceId: string): Promise<void> {
	const what =
		e.to === "stop"
			? Number.isFinite(e.usage)
				? "is reached: the purchase gate now refuses every sale that counts toward it"
				: "cannot be read (an invoice has no EUR amount or no USD amount): the purchase gate refuses every sale that counts toward it until it can"
			: `is at ${percent(e.usage)} of the threshold (warning margin)`;
	await alertOperator({
		title: `Tax threshold ${e.to === "stop" ? "reached" : "nearing"}: ${e.label}`,
		subject: { type: "tax_threshold", id: e.key },
		summary:
			`${e.label} ${what}. Recorded on Stripe invoice ${stripeInvoiceId}. See the admin ` +
			"/turnover page, and act on the recorded decision for this threshold (register, or stop " +
			"selling into the cell) — TAX_MARKET_PRECONDITIONS.md §3.1 item 5.",
	});
}

/**
 * Records the tax facts of a paid, already-mirrored invoice and alerts on any threshold it raised.
 * Idempotent: a replay finds the snapshot and writes nothing, except a EUR amount that was missing.
 * Throws only on a database error; the webhook wraps it so a failure never fails the event.
 */
export async function recordInvoiceFacts(
	inv: Stripe.Invoice,
	orgId: string,
	opts: RecordFactsOptions = {},
): Promise<RecordFactsResult> {
	if (!inv.id) return { recorded: false, reason: "no_invoice_id" };
	const stripeInvoiceId = inv.id;
	const store = opts.store ?? liveInvoiceFactsStore;
	const now = (opts.now ?? (() => new Date()))();
	const warnMargin = opts.warnMargin ?? DEFAULT_WARN_MARGIN;

	const declaration = await store.declaration(orgId);
	const currency = inv.currency.toLowerCase();
	// Net of VAT, which is what every threshold counts (an unregistered seller charges none, so this
	// is the total; the field is read in case Stripe Tax is ever on).
	const net = inv.total_excluding_tax ?? inv.total;
	const rate = await (opts.eurRate ?? ecbEurRate)(currency, paidAtOf(inv, now));
	const eur: InvoiceSnapshotPatch = rate
		? { amountEurMinor: toEurMinor(net, currency, rate), eurRate: rate.eurPerUnit, eurRateSource: rate.source }
		: {};

	const outcome = await store.locked(async (tx) => {
		const row = await tx.invoiceRow(stripeInvoiceId);
		if (!row) return { kind: "not_mirrored" as const };
		const fresh = !hasSnapshot(row);
		const patch: InvoiceSnapshotPatch = fresh
			? { ...snapshotOf(declaration), ...eur }
			: row.amountEurMinor === null
				? eur
				: {};
		if (Object.keys(patch).length === 0) return { kind: "already_recorded" as const };

		const others = (await tx.factsSince(turnoverWindowStart(now))).filter((f) => f.id !== row.id);
		const after = applied(row, patch);
		const before = assessTurnover(turnoverTotals(others, now), warnMargin);
		const withIt = assessTurnover(turnoverTotals([...others, after], now), warnMargin);
		await tx.writeSnapshot(row.id, patch);
		// Only a sale that counts toward a EUR total needs a EUR amount; a US sale does not.
		const needsEur = thresholdCountersForSale({
			country: after.country,
			capacity: after.capacity,
			vatIdGiven: after.vatIdGiven,
			state: after.state,
		}).some((c) => c.id !== "us_state");
		return {
			kind: "recorded" as const,
			snapshot: fresh,
			eurMissing: needsEur && after.amountEurMinor === null && after.currency.toLowerCase() !== "eur",
			eurConverted: after.amountEurMinor !== null,
			escalations: thresholdEscalations(before, withIt),
		};
	});

	if (outcome.kind !== "recorded") {
		if (outcome.kind === "not_mirrored") {
			log.error(`[billing] invoice facts: ${stripeInvoiceId} was never mirrored; facts not recorded`);
		}
		return { recorded: false, reason: outcome.kind };
	}
	if (outcome.eurMissing) {
		await alertOperator({
			title: "A paid invoice has no EUR amount",
			subject: { type: "tax_threshold", id: `eur_rate:${stripeInvoiceId}` },
			summary:
				`Stripe invoice ${stripeInvoiceId} (organization ${orgId}, ${currency.toUpperCase()}) was ` +
				"paid but no EUR rate could be had. Every EUR threshold it counts toward reads unreadable " +
				"and the purchase gate refuses those sales until it is converted. Replay its " +
				"invoice.payment_succeeded event (break-glass replay_webhook) once the ECB rate is available.",
		});
	}
	for (const e of outcome.escalations) await alertEscalation(e, stripeInvoiceId);
	return {
		recorded: true,
		snapshot: outcome.snapshot,
		eurConverted: outcome.eurConverted,
		escalations: outcome.escalations,
	};
}

// ── Refunds ─────────────────────────────────────────────────────────────────────────────────────

/** The Stripe calls the refund path makes. */
export type InvoicePaymentsReader = Pick<Stripe, "invoicePayments">;

/**
 * The one Stripe call that finds the invoice a PaymentIntent paid, as a structural type: the Stripe
 * client satisfies it, and so does a test double that implements only this call.
 */
export interface InvoicePaymentLookup {
	invoicePayments: {
		list(params: {
			payment: { type: "payment_intent"; payment_intent: string };
			limit: number;
		}): Promise<{ data: { invoice?: string | { id?: string } | null }[] }>;
	};
}

/**
 * Marks the invoice a FULLY refunded charge paid as `refunded`, so it drops out of every total.
 * A partial refund changes nothing (see the file header). The charge names no invoice in this API
 * version, so the invoice is found through the charge's PaymentIntent. Returns the Stripe invoice id
 * it marked, or null. A Stripe error throws, so the event fails and Stripe redelivers it.
 */
export async function markRefundedInvoice(
	charge: Stripe.Charge,
	stripe: InvoicePaymentsReader,
): Promise<string | null> {
	if (!charge.refunded) return null;
	const invoiceId = await invoiceIdOfPaymentIntent(charge.payment_intent, stripe);
	if (!invoiceId) return null;
	await setInvoiceStatus(invoiceId, "refunded");
	return invoiceId;
}

/**
 * The Stripe invoice a PaymentIntent paid, or null. A charge or refund names no invoice in this API
 * version, so the invoice is found through its invoice payment. Shared by the refund status write
 * above and the credit-note issuer (lib/billing/factura/credit-note.ts). A Stripe error throws.
 */
export async function invoiceIdOfPaymentIntent(
	pi: string | Stripe.PaymentIntent | null | undefined,
	stripe: InvoicePaymentLookup,
): Promise<string | null> {
	const paymentIntent = typeof pi === "string" ? pi : (pi?.id ?? null);
	if (!paymentIntent) return null;
	const payments = await stripe.invoicePayments.list({
		payment: { type: "payment_intent", payment_intent: paymentIntent },
		limit: 1,
	});
	const ref = payments.data[0]?.invoice;
	return typeof ref === "string" ? ref : (ref?.id ?? null);
}

// ── The totals, for the purchase gate ───────────────────────────────────────────────────────────

/** Every running total as of `now`, summed from the invoice rows by `@repo/legal/turnover`. */
export async function readTurnoverTotals(
	now: Date = new Date(),
	store: InvoiceFactsStore = liveInvoiceFactsStore,
): Promise<TurnoverTotals> {
	return turnoverTotals(await store.factsSince(turnoverWindowStart(now)), now);
}

/**
 * The check EA-2's gate runs BEFORE taking a sale: the totals as they stand, with this sale added,
 * against each threshold it counts toward. `stop` means refuse with `threshold_reached`. A database
 * error throws, and the gate must treat a throw as a refusal.
 */
export async function assessSaleBeforeCharge(
	sale: ProspectiveSale,
	opts: { now?: Date; store?: InvoiceFactsStore; warnMargin?: number } = {},
): Promise<SaleAssessment> {
	const totals = await readTurnoverTotals(opts.now, opts.store);
	return assessSaleAgainstTurnover(totals, sale, opts.warnMargin);
}
