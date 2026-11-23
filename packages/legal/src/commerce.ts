// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The commercial-law facts a paid conversion depends on, in ONE place both the console and the
// marketing site read (#2372).
//
// Everything here is pure data and pure functions: no database, no Stripe, no React. That is what
// lets the same rule be asserted in a unit test, enforced in a server action, and rendered on a
// public page without three copies drifting apart — the failure mode #2371 already recorded for the
// processing register.

import type { LegalDocumentLocale } from "./documents";
import { PAID_MARKETS } from "./paid-markets";

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

/** Both payer capacities, `consumer` first. */
export const PAYER_CAPACITIES: readonly PayerCapacity[] = [
	"consumer",
	"organization",
];

/**
 * Whether an ORGANIZATION buyer gave a VAT identification number.
 *
 *  - `given` — the buyer communicated a VAT number.
 *  - `not_given` — the buyer declared that it has none, or chose not to give one. For an EU buyer
 *    outside Bulgaria this is what the Art. 18(2) presumption of Implementing Regulation 282/2011
 *    rests on, so the order must record it (`docs/legal/TAX_MARKET_PRECONDITIONS.md` §3.4).
 *
 * Like the capacity, it is CAPTURED, never inferred, and it is asked neutrally: nothing may hint that
 * one answer opens a sale the other does not. An undeclared status is `null`, never a default.
 */
export type VatIdStatus = "given" | "not_given";

/** Both VAT-number statuses, `given` first. */
export const VAT_ID_STATUSES: readonly VatIdStatus[] = ["given", "not_given"];

/** The country the seller is established in, ISO 3166-1 alpha-2. */
export const SELLER_COUNTRY = "BG";

/**
 * The 27 EU member states, ISO 3166-1 alpha-2. Greece is `GR` here; `EL` is its VAT prefix, not its
 * country code. (Defined here rather than in launch.ts because the VAT-number rule needs it, and
 * launch.ts re-exports it so existing imports keep working.)
 */
export const EU_MEMBER_STATES: readonly string[] = [
	"AT",
	"BE",
	"BG",
	"CY",
	"CZ",
	"DE",
	"DK",
	"EE",
	"ES",
	"FI",
	"FR",
	"GR",
	"HR",
	"HU",
	"IE",
	"IT",
	"LT",
	"LU",
	"LV",
	"MT",
	"NL",
	"PL",
	"PT",
	"RO",
	"SE",
	"SI",
	"SK",
];

/** One country × capacity pair, optionally narrowed by VAT-number status, the product may sell into. */
export interface PaidMarketCell {
	/** ISO 3166-1 alpha-2, upper-case. */
	readonly country: string;
	readonly capacity: PayerCapacity;
	/**
	 * Narrows an `organization` cell to buyers that gave (`given`) or did not give (`not_given`) a
	 * VAT number. Absent means either. See `PAID_MARKETS` for when each is used.
	 */
	readonly vatId?: VatIdStatus;
	/** The evidence that opened this cell — an audit trail, not a comment. */
	readonly evidence: string;
}

// The cell list itself lives in paid-markets.ts (owned by the unit that opens cells) and is
// re-exported here so `import { PAID_MARKETS } from "@repo/legal/commerce"` keeps working.
export { PAID_MARKETS };

/** The country as an upper-case alpha-2 code, or `null` when it is missing or not two characters. */
function normaliseCountry(country: string | null | undefined): string | null {
	if (!country) return null;
	const iso = country.trim().toUpperCase();
	return iso.length === 2 ? iso : null;
}

/**
 * The VAT-number status as the boolean the gate is called with: `true` for `given`, `false` for
 * `not_given`, `null` when nothing was declared. The inverse of `vatIdStatusOf`.
 */
export function vatIdGivenOf(status: VatIdStatus | null | undefined): boolean | null {
	if (status === "given") return true;
	if (status === "not_given") return false;
	return null;
}

/** The VAT-number status for a boolean answer, or `null` when the answer is unknown. */
export function vatIdStatusOf(vatIdGiven: boolean | null | undefined): VatIdStatus | null {
	if (vatIdGiven === true) return "given";
	if (vatIdGiven === false) return "not_given";
	return null;
}

/**
 * Whether the purchase gate must know the buyer's VAT-number status before it can answer: true for
 * an `organization` in an EU member state other than the seller's own.
 *
 * That is where the status changes the tax treatment of the sale (reverse charge and the seller's
 * registration, against the no-VAT-number presumption and the EUR 10,000 threshold). In Bulgaria
 * and outside the EU it does not, so an undeclared status there is not a reason to refuse.
 */
export function vatIdStatusRequired(
	country: string | null | undefined,
	capacity: PayerCapacity | null | undefined,
): boolean {
	const iso = normaliseCountry(country);
	return (
		capacity === "organization" &&
		iso !== null &&
		iso !== SELLER_COUNTRY &&
		EU_MEMBER_STATES.includes(iso)
	);
}

/**
 * The cell in `cells` that opens this buyer, or `undefined` — the ONE matching rule.
 * `paidMarketEnabled`, `paidMarketEvidence` and launch.ts's `paidLaunchCell` all call it, so they
 * cannot disagree.
 *
 * A cell matches when its country (exact, upper-case) and capacity equal the buyer's, and its `vatId`
 * is absent or equal to the buyer's status. FAIL-CLOSED throughout:
 *
 *  - a missing or malformed country, or an undeclared capacity, matches nothing;
 *  - an `organization` in an EU member state other than the seller's with an undeclared VAT status
 *    (`null`) matches nothing, not even a cell without `vatId`;
 *  - a cell narrowed by `vatId` never matches an undeclared status, and never matches a `consumer`
 *    (a consumer has no VAT-number status).
 */
export function matchPaidMarketCell(
	cells: readonly PaidMarketCell[],
	country: string | null | undefined,
	capacity: PayerCapacity | null | undefined,
	vatIdGiven: boolean | null | undefined,
): PaidMarketCell | undefined {
	const iso = normaliseCountry(country);
	if (iso === null || !capacity || !PAYER_CAPACITIES.includes(capacity)) return undefined;
	const status = capacity === "organization" ? vatIdStatusOf(vatIdGiven) : null;
	if (status === null && vatIdStatusRequired(iso, capacity)) return undefined;
	return cells.find(
		(cell) =>
			cell.country === iso &&
			cell.capacity === capacity &&
			(cell.vatId === undefined || cell.vatId === status),
	);
}

/**
 * Whether the product may take money from this buyer today.
 *
 * FAIL-CLOSED by construction: an empty PAID_MARKETS refuses everything, an unknown country refuses,
 * and a missing country refuses rather than defaulting to the seller's own jurisdiction. An EU
 * organization outside Bulgaria with an undeclared VAT status (`vatIdGiven` null or omitted) is
 * refused; in Bulgaria and the US the status is not needed. The reader exists so the answer is
 * computed in one place — a caller doing `PAID_MARKETS.length > 0` would be asking a different,
 * weaker question.
 *
 * @param vatIdGiven whether an organization gave a VAT number; `null`/omitted when undeclared.
 *   Ignored for a consumer.
 */
export function paidMarketEnabled(
	country: string | null | undefined,
	capacity: PayerCapacity | null | undefined,
	vatIdGiven: boolean | null = null,
): boolean {
	return matchPaidMarketCell(PAID_MARKETS, country, capacity, vatIdGiven) !== undefined;
}

/**
 * Whether ANY cell is open — "is anything on sale anywhere", NOT "may this payer buy". It decides
 * only whether the purchase sheet may skip straight to saying "not on sale yet" before asking the
 * payer anything; once any cell opens, `paidMarketEnabled` (through the console's
 * `assertPaidConversionAllowed`) stays the authority for each declared payer.
 */
export function anyPaidMarketOpen(): boolean {
	return PAID_MARKETS.length > 0;
}

/** The evidence recorded for the cell that opens this buyer, or null when no cell does. */
export function paidMarketEvidence(
	country: string | null | undefined,
	capacity: PayerCapacity | null | undefined,
	vatIdGiven: boolean | null = null,
): string | null {
	return matchPaidMarketCell(PAID_MARKETS, country, capacity, vatIdGiven)?.evidence ?? null;
}

/**
 * Whether this buyer is routed to the complimentary Early Access grant instead of a sale: exactly an
 * `organization` in an EU member state other than the seller's that GAVE a VAT number, while the
 * seller is not VAT-registered.
 *
 * Such a sale would be a supply for consideration that needs the seller's Art. 97a registration first
 * (`docs/legal/TAX_MARKET_PRECONDITIONS.md` §3.3). A free grant is not, so it may be given today; the
 * customer is billed only after the registration, going forward. Once `vatRegistered` is true the
 * buyer is an ordinary sale and this is false. An undeclared status is never eligible.
 *
 * @param vatRegistered in production, `LEGAL_ENTITY.vatRegistered`.
 */
export function complimentaryGrantEligible(
	country: string | null | undefined,
	capacity: PayerCapacity | null | undefined,
	vatIdGiven: boolean | null | undefined,
	vatRegistered: boolean,
): boolean {
	return vatIdStatusRequired(country, capacity) && vatIdGiven === true && !vatRegistered;
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
 * The language a consumer's statutory texts are given in: Bulgarian for a buyer whose billing country
 * is Bulgaria (ЗЗП art. 52a, and the Bulgarian-language rule for consumer information), English
 * otherwise. Uses the same locale codes as `LEGAL_DOCUMENTS[].locales`.
 */
export type ConsumerLocale = LegalDocumentLocale;

/**
 * The locale a consumer with this billing country is addressed in: `bg-BG` for `BG` (any case,
 * surrounding whitespace ignored), `en` for everything else, including a missing country.
 */
export function consumerLocaleFor(country: string | null | undefined): ConsumerLocale {
	return normaliseCountry(country) === SELLER_COUNTRY ? "bg-BG" : "en";
}

/** The four `basis` sentences, in one language. The proportional one takes the day counts. */
export interface WithdrawalBasisText {
	readonly deferred: string;
	readonly notAcknowledged: string;
	readonly noPeriod: string;
	readonly proportional: (supplied: number, periodDays: number) => string;
}

/**
 * Every `basis` sentence `withdrawalOutcome` can return, per locale. A parallel map rather than a
 * translation call, so each language's wording is reviewable as text, and a test can require that
 * every locale covers every outcome.
 */
export const WITHDRAWAL_BASIS: Readonly<Record<ConsumerLocale, WithdrawalBasisText>> = {
	en: {
		deferred:
			"Service was not supplied during the withdrawal period, so the full amount is refunded.",
		notAcknowledged:
			"Immediate performance was requested but the proportional charge was not acknowledged at " +
			"purchase, so no part of the price may be retained and the full amount is refunded.",
		noPeriod:
			"The billed period has no measurable length, so no proportion can be retained and the " +
			"full amount is refunded.",
		proportional: (supplied, periodDays) =>
			`Immediate performance was requested and the proportional charge acknowledged, so the ` +
			`amount for ${supplied} of ${periodDays} day(s) supplied is retained and the rest refunded.`,
	},
	"bg-BG": {
		deferred:
			"Услугата не е предоставяна през срока за отказ, затова цялата сума се възстановява.",
		notAcknowledged:
			"Поискано е незабавно изпълнение, но при покупката не е потвърдено задължението за " +
			"пропорционално плащане, затова не може да бъде задържана никаква част от цената и цялата " +
			"сума се възстановява.",
		noPeriod:
			"Платеният период няма измерима продължителност, затова не може да бъде задържана " +
			"пропорционална част и цялата сума се възстановява.",
		proportional: (supplied, periodDays) =>
			`Поискано е незабавно изпълнение и е потвърдено задължението за пропорционално плащане, ` +
			`затова се задържа сумата за предоставените ${supplied} от ${periodDays} дни, а остатъкът се възстановява.`,
	},
};

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
 *
 * `locale` chooses only the language of `basis` (from {@link WITHDRAWAL_BASIS}); the figures never
 * depend on it.
 */
export function withdrawalOutcome(
	input: WithdrawalAccounting,
	locale: ConsumerLocale = "en",
): WithdrawalOutcome {
	const text = WITHDRAWAL_BASIS[locale];
	const paid = Math.max(0, Math.floor(input.paidMinorUnits));
	const refundAll = (basis: string): WithdrawalOutcome => ({
		retainedMinorUnits: 0,
		refundMinorUnits: paid,
		basis,
	});

	if (input.performanceStart === "deferred") {
		return refundAll(text.deferred);
	}
	if (!input.acknowledgedProportionalCharge) {
		return refundAll(text.notAcknowledged);
	}
	if (input.periodDays <= 0) {
		return refundAll(text.noPeriod);
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
		basis: text.proportional(supplied, input.periodDays),
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

/**
 * The consumer order button's label in Bulgarian. ЗЗП art. 49(2), which transposes CRD art. 8(2),
 * names the formulation „поръчка със задължение за плащане“. It lives here for the same reason as
 * the English one.
 */
export const CONSUMER_PAYMENT_OBLIGATION_LABEL_BG = "Поръчка със задължение за плащане";

/** The order button's label for an ORGANIZATION purchase, where the CRD does not apply. */
export const ORGANIZATION_ORDER_LABEL = "Confirm and pay";

/** {@link ORGANIZATION_ORDER_LABEL} in Bulgarian. */
export const ORGANIZATION_ORDER_LABEL_BG = "Потвърждаване и плащане";

/**
 * The label to render for a given payer capacity, in the consumer's locale (`en` by default; see
 * {@link consumerLocaleFor}).
 */
export function orderButtonLabel(
	capacity: PayerCapacity,
	locale: ConsumerLocale = "en",
): string {
	if (locale === "bg-BG") {
		return capacity === "consumer"
			? CONSUMER_PAYMENT_OBLIGATION_LABEL_BG
			: ORGANIZATION_ORDER_LABEL_BG;
	}
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
	/** {@link role} in Bulgarian, for the Bulgarian section of the Consumer rights page. */
	readonly localRole: string;
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
		localRole:
			"Българският орган за защита на потребителите — жалби относно поведението на търговец.",
	},
	{
		name: "General Conciliation Commission, Sofia",
		localName: "Обща помирителна комисия — София",
		url: "https://kzp.bg/bg/pomiritelna-komisiya",
		role: "Alternative dispute resolution for consumer disputes with traders established in Bulgaria.",
		localRole:
			"Алтернативно решаване на потребителски спорове с търговци, установени в България.",
	},
];
