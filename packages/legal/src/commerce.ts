// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The commercial-law facts a paid conversion depends on, in ONE place both the console and the
// marketing site read (#2372).
//
// Everything here is pure data and pure functions: no database, no Stripe, no React. That is what
// lets the same rule be asserted in a unit test, enforced in a server action, and rendered on a
// public page without three copies drifting apart — the failure mode #2371 already recorded for the
// processing register.

/**
 * WHO is paying, which decides WHICH law applies.
 *
 *  - `consumer` — a natural person acting outside their trade, business or profession. EU consumer
 *    law attaches: pre-contractual information, the unambiguous payment-obligation button, the
 *    14-day statutory withdrawal right, durable confirmation, and ADR information.
 *  - `organization` — a legal person, or a natural person acting in a business capacity. None of
 *    the consumer protections above apply, and a VAT/tax id may be collected.
 *
 * It is CAPTURED, never inferred. Guessing from "did they type a company name?" would decide the
 * applicable legal regime on a text field, and getting it wrong in the `organization` direction
 * strips a real consumer of rights they cannot waive.
 */
export type PayerCapacity = "consumer" | "organization";

export const PAYER_CAPACITIES: readonly PayerCapacity[] = [
	"consumer",
	"organization",
];

/** One country × capacity pair the product may lawfully sell into. */
export interface PaidMarketCell {
	/** ISO 3166-1 alpha-2, upper-case. */
	readonly country: string;
	readonly capacity: PayerCapacity;
	/** The evidence that opened this cell — an audit trail, not a comment. */
	readonly evidence: string;
}

/**
 * The country × capacity cells paid conversion is enabled for.
 *
 * ⚠️ IT IS EMPTY, AND EMPTY IS THE CORRECT STATE TODAY. `LEGAL_ENTITY.vatRegistered` is `false`:
 * the company is not VAT-registered, so cross-border B2C sales into the EU have no OSS return to
 * report through, and there is no basis on which to charge a Bulgarian consumer VAT-inclusive
 * pricing either. Selling first and papering it later is the one order these gates exist to prevent.
 *
 * A cell may be added ONLY when all four hold, and the evidence string must say which:
 *
 *  1. **Tax** — a registration that covers the sale (VAT/OSS for EU B2C, or a documented basis for
 *     charging none), and Stripe Tax configured to compute it for that country and capacity.
 *  2. **Stripe** — the account is live (not test), enabled for that country's payment methods, with
 *     the tax and invoicing settings the sale needs.
 *  3. **Contractual** — Terms, and for `consumer` cells the consumer-rights disclosures, published
 *     in a language the market requires, at a version whose hash is sealed (see documents.ts).
 *  4. **Commercial rights** — for `consumer` cells: the withdrawal, confirmation and ADR duties are
 *     implemented AND the ADR body named in CONSUMER_ADR is the correct one for that country.
 *
 * The checklist and its current state live in `docs/legal/PAID_MARKETS.md`. Adding a cell here
 * without the evidence is not a shortcut — it converts a compliance gap into a live sale.
 */
export const PAID_MARKETS: readonly PaidMarketCell[] = [];

/**
 * Whether the product may take money from this country × capacity today.
 *
 * FAIL-CLOSED by construction: an empty PAID_MARKETS refuses everything, an unknown country refuses,
 * and a missing country refuses rather than defaulting to the seller's own jurisdiction. The reader
 * exists so the answer is computed in one place — a caller doing `PAID_MARKETS.length > 0` would be
 * asking a different, weaker question.
 */
export function paidMarketEnabled(
	country: string | null | undefined,
	capacity: PayerCapacity | null | undefined,
): boolean {
	if (!country || !capacity) return false;
	const iso = country.trim().toUpperCase();
	if (iso.length !== 2) return false;
	return PAID_MARKETS.some(
		(cell) => cell.country === iso && cell.capacity === capacity,
	);
}

/** The evidence recorded for an enabled cell, or null when the cell is closed. */
export function paidMarketEvidence(
	country: string | null | undefined,
	capacity: PayerCapacity | null | undefined,
): string | null {
	if (!country || !capacity) return null;
	const iso = country.trim().toUpperCase();
	return (
		PAID_MARKETS.find(
			(cell) => cell.country === iso && cell.capacity === capacity,
		)?.evidence ?? null
	);
}

// ── Consumer withdrawal ─────────────────────────────────────────────────────────────────────────

/** The statutory withdrawal period for a distance contract, in days (CRD art. 9). */
export const WITHDRAWAL_PERIOD_DAYS = 14;

/**
 * What a consumer chose about performance starting inside the withdrawal period.
 *
 *  - `deferred` — service starts when the 14 days elapse. Withdrawal costs the consumer nothing.
 *  - `immediate` — the consumer expressly requested performance during the period and acknowledged
 *    that they will owe a proportion of the price if they then withdraw (CRD art. 14(3)). Both
 *    halves are required: the request alone, without the acknowledgement, leaves the trader unable
 *    to charge anything at all.
 */
export type PerformanceStart = "deferred" | "immediate";

/** One consumer's withdrawal, as the accounting needs it. */
export interface WithdrawalAccounting {
	/** Total the consumer was charged, tax-inclusive, in minor units. */
	readonly paidMinorUnits: number;
	/** Length of the billed period, in days. */
	readonly periodDays: number;
	/** Days of service actually supplied before the withdrawal took effect. */
	readonly daysSupplied: number;
	readonly performanceStart: PerformanceStart;
	/** Whether the consumer acknowledged the proportional charge when asking for immediate start. */
	readonly acknowledgedProportionalCharge: boolean;
}

/** The split a withdrawal produces. `retained + refund === paidMinorUnits`, always. */
export interface WithdrawalOutcome {
	/** What the trader may keep, in minor units. */
	readonly retainedMinorUnits: number;
	/** What must be refunded, in minor units. */
	readonly refundMinorUnits: number;
	/** Why — rendered to the consumer, so it is part of the calculation, not a UI string. */
	readonly basis: string;
}

/**
 * The MANDATORY proportional accounting for a consumer exercising the statutory withdrawal right
 * (CRD art. 14(3)). Not a refund policy — a legal computation, which is why it is a pure function
 * with its own tests rather than a branch inside a Stripe call.
 *
 * Three outcomes, and the two that favour the consumer are the ones easiest to get wrong:
 *
 *  1. Performance was DEFERRED — nothing was supplied, so the whole price is refunded. A trader
 *     that keeps a "processing fee" here is simply wrong.
 *  2. Performance was immediate but the consumer never ACKNOWLEDGED the proportional charge — the
 *     trader may keep NOTHING, even though service was genuinely supplied. That is the sanction for
 *     not obtaining the acknowledgement, and it is deliberate: it is why the purchase flow must
 *     capture both halves, not just the request.
 *  3. Performance was immediate AND acknowledged — the trader keeps the proportion of the price
 *     corresponding to what was supplied up to the moment of withdrawal.
 *
 * Rounding favours the consumer: the retained amount is floored, so a fractional minor unit becomes
 * refund rather than revenue.
 */
export function withdrawalOutcome(
	input: WithdrawalAccounting,
): WithdrawalOutcome {
	const paid = Math.max(0, Math.floor(input.paidMinorUnits));
	const refundAll = (basis: string): WithdrawalOutcome => ({
		retainedMinorUnits: 0,
		refundMinorUnits: paid,
		basis,
	});

	if (input.performanceStart === "deferred") {
		return refundAll(
			"Service was not supplied during the withdrawal period, so the full amount is refunded.",
		);
	}
	if (!input.acknowledgedProportionalCharge) {
		return refundAll(
			"Immediate performance was requested but the proportional charge was not acknowledged at " +
				"purchase, so no part of the price may be retained and the full amount is refunded.",
		);
	}
	if (input.periodDays <= 0) {
		return refundAll(
			"The billed period has no measurable length, so no proportion can be retained and the " +
				"full amount is refunded.",
		);
	}

	const supplied = Math.min(
		Math.max(0, input.daysSupplied),
		input.periodDays,
	);
	// Floored: a fractional minor unit goes to the consumer, never to us.
	const retained = Math.floor((paid * supplied) / input.periodDays);
	return {
		retainedMinorUnits: retained,
		refundMinorUnits: paid - retained,
		basis:
			`Immediate performance was requested and the proportional charge acknowledged, so the ` +
			`amount for ${supplied} of ${input.periodDays} day(s) supplied is retained and the rest refunded.`,
	};
}

// ── Contract formation ──────────────────────────────────────────────────────────────────────────

/**
 * The order button's label for a CONSUMER purchase.
 *
 * CRD art. 8(2) requires the button to be labelled with an unambiguous statement that the order
 * carries an obligation to pay; "Order with an obligation to pay" is the formulation the article
 * names, and a trader who uses something vaguer ("Continue", "Subscribe") does not bind the
 * consumer at all. Kept here rather than in a component so the string cannot be softened by a
 * copy edit that nobody reads as a legal change.
 */
export const CONSUMER_PAYMENT_OBLIGATION_LABEL = "Order with an obligation to pay";

/** The order button's label for an ORGANIZATION purchase, where the CRD does not apply. */
export const ORGANIZATION_ORDER_LABEL = "Confirm and pay";

/** The label to render for a given payer capacity. */
export function orderButtonLabel(capacity: PayerCapacity): string {
	return capacity === "consumer"
		? CONSUMER_PAYMENT_OBLIGATION_LABEL
		: ORGANIZATION_ORDER_LABEL;
}

// ── Dispute resolution ──────────────────────────────────────────────────────────────────────────

/** A body a consumer can take a dispute to. */
export interface ConsumerDisputeBody {
	readonly name: string;
	readonly localName: string;
	readonly url: string;
	readonly role: string;
}

/**
 * The consumer dispute-resolution information a Bulgarian trader must give.
 *
 * ⚠️ THE EU ODR PLATFORM IS NOT LISTED, AND MUST NOT BE. Regulation (EU) 524/2013 was repealed and
 * the Commission's ODR platform ceased operating on 20 July 2025; the duty to link it went with it.
 * A link to it today points consumers at a dead service and states an obligation that no longer
 * exists — which is worse than silence, because it reads as current legal information. This comment
 * exists because "add the ODR link" is still the advice in most templates.
 */
export const CONSUMER_ADR: readonly ConsumerDisputeBody[] = [
	{
		name: "Commission for Consumer Protection",
		localName: "Комисия за защита на потребителите (КЗП)",
		url: "https://kzp.bg/",
		role: "The Bulgarian consumer-protection authority — complaints about a trader's conduct.",
	},
	{
		name: "General Conciliation Commission, Sofia",
		localName: "Обща помирителна комисия — София",
		url: "https://kzp.bg/pomiritelna-komisiya",
		role: "Alternative dispute resolution for consumer disputes with traders established in Bulgaria.",
	},
];
