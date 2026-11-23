// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	CONSUMER_ADR,
	CONSUMER_PAYMENT_OBLIGATION_LABEL,
	CONSUMER_PAYMENT_OBLIGATION_LABEL_BG,
	EU_MEMBER_STATES,
	PAID_MARKETS,
	type PaidMarketCell,
	SELLER_COUNTRY,
	VAT_ID_STATUSES,
	anyPaidMarketOpen,
	WITHDRAWAL_BASIS,
	complimentaryGrantEligible,
	consumerLocaleFor,
	matchPaidMarketCell,
	orderButtonLabel,
	paidMarketEnabled,
	paidMarketEvidence,
	vatIdGivenOf,
	vatIdStatusOf,
	vatIdStatusRequired,
	withdrawalOutcome,
} from "./commerce";
import { LEGAL_ENTITY } from "./entity";
import { PAID_MARKETS as PAID_MARKETS_SOURCE } from "./paid-markets";

/** The EU member states other than the seller's own. */
const OTHER_MEMBER_STATES = EU_MEMBER_STATES.filter((country) => country !== SELLER_COUNTRY);

describe("paid markets", () => {
	// The gate is only a gate while it is shut. This is not "assert the current value" — it is the
	// invariant that opening a cell requires the evidence, and the evidence does not exist yet:
	// LEGAL_ENTITY.vatRegistered is false, so there is no registration under which to charge VAT.
	it("is closed, and stays closed while the company is not VAT-registered", () => {
		if (!LEGAL_ENTITY.vatRegistered) {
			expect(PAID_MARKETS).toHaveLength(0);
		}
	});

	it("refuses everything while no cell is open", () => {
		expect(paidMarketEnabled("BG", "consumer")).toBe(false);
		expect(paidMarketEnabled("DE", "organization")).toBe(false);
		if (PAID_MARKETS.length > 0) return;
		for (const country of [...EU_MEMBER_STATES, "US", "CA"]) {
			for (const given of [true, false, null]) {
				expect(paidMarketEnabled(country, "organization", given)).toBe(false);
				expect(paidMarketEnabled(country, "consumer", given)).toBe(false);
			}
		}
	});

	// One list, two import paths: the unit that opens cells owns paid-markets.ts, and every existing
	// import from commerce.ts must see the same array, not a copy.
	it("re-exports the cell list from paid-markets.ts unchanged", () => {
		expect(PAID_MARKETS).toBe(PAID_MARKETS_SOURCE);
	});

	// "Is anything on sale anywhere" agrees with the list it reads: open exactly when a cell exists.
	it("reports a market open anywhere exactly when a cell is open", () => {
		expect(anyPaidMarketOpen()).toBe(PAID_MARKETS.length > 0);
		if (!LEGAL_ENTITY.vatRegistered) expect(anyPaidMarketOpen()).toBe(false);
	});

	// Fail-closed on the inputs too, not only on the list: a missing country must never fall back to
	// the seller's own jurisdiction, which is the plausible-looking default that would enable exactly
	// the market we are least ready to sell into.
	it("refuses missing, malformed and unknown inputs rather than defaulting", () => {
		expect(paidMarketEnabled(null, "consumer")).toBe(false);
		expect(paidMarketEnabled("", "consumer")).toBe(false);
		expect(paidMarketEnabled("BG", null)).toBe(false);
		expect(paidMarketEnabled("BGR", "consumer")).toBe(false);
		expect(paidMarketEnabled("b", "consumer")).toBe(false);
	});

	// Every cell carries an audit trail, so a cell cannot be opened by editing an array.
	it("requires evidence and an upper-case ISO-3166 alpha-2 country on every cell", () => {
		for (const cell of PAID_MARKETS) {
			expect(cell.country).toMatch(/^[A-Z]{2}$/);
			expect(cell.evidence.trim().length).toBeGreaterThan(20);
			const given = vatIdGivenOf(cell.vatId) ?? false;
			expect(paidMarketEnabled(cell.country, cell.capacity, given)).toBe(true);
			expect(paidMarketEvidence(cell.country, cell.capacity, given)).not.toBeNull();
		}
	});

	// A consumer has no VAT-number status, so a consumer cell narrowed by one could never match: it
	// would read as open in this file and open nothing in the gate.
	it("narrows only organization cells by VAT-number status", () => {
		for (const cell of PAID_MARKETS) {
			if (cell.vatId !== undefined) expect(cell.capacity).toBe("organization");
		}
	});

	// While the seller is not registered, no cell may sell to an EU business outside Bulgaria that
	// gives a VAT number: that buyer gets the complimentary grant (TAX_MARKET_PRECONDITIONS §3.3).
	it("opens no VAT-number EU business outside Bulgaria while the seller is unregistered", () => {
		if (LEGAL_ENTITY.vatRegistered) return;
		for (const country of OTHER_MEMBER_STATES) {
			expect(paidMarketEnabled(country, "organization", true)).toBe(false);
		}
	});
});

describe("the matching rule, on synthetic cells", () => {
	const evidence = "Synthetic evidence used only by this test file.";
	const cells: readonly PaidMarketCell[] = [
		{ country: "BG", capacity: "organization", evidence },
		{ country: "DE", capacity: "organization", vatId: "not_given", evidence },
		{ country: "FR", capacity: "organization", evidence },
		{ country: "IT", capacity: "consumer", vatId: "not_given", evidence },
	];

	it("matches a country trimmed and case-insensitively", () => {
		expect(matchPaidMarketCell(cells, " bg ", "organization", null)).toBe(cells[0]);
		expect(matchPaidMarketCell(cells, "bg", "organization", true)).toBe(cells[0]);
	});

	// THE property of the dimension: a no-VAT-number cell never opens the VAT-number case.
	it("does not open the VAT-number case from a not_given cell", () => {
		expect(matchPaidMarketCell(cells, "DE", "organization", false)).toBe(cells[1]);
		expect(matchPaidMarketCell(cells, "DE", "organization", true)).toBeUndefined();
	});

	// Unknown status: fail closed in the EU outside Bulgaria, pass in Bulgaria and the US.
	it("refuses an undeclared VAT status in another member state, even on a cell without vatId", () => {
		expect(matchPaidMarketCell(cells, "FR", "organization", null)).toBeUndefined();
		expect(matchPaidMarketCell(cells, "FR", "organization", undefined)).toBeUndefined();
		expect(matchPaidMarketCell(cells, "FR", "organization", true)).toBe(cells[2]);
		expect(matchPaidMarketCell(cells, "FR", "organization", false)).toBe(cells[2]);
		expect(matchPaidMarketCell(cells, "DE", "organization", null)).toBeUndefined();
		expect(matchPaidMarketCell(cells, "BG", "organization", null)).toBe(cells[0]);
		const us: readonly PaidMarketCell[] = [{ country: "US", capacity: "organization", evidence }];
		expect(matchPaidMarketCell(us, "US", "organization", null)).toBe(us[0]);
	});

	it("never matches a consumer against a cell narrowed by vatId", () => {
		for (const given of [true, false, null]) {
			expect(matchPaidMarketCell(cells, "IT", "consumer", given)).toBeUndefined();
		}
	});

	it("refuses missing and malformed inputs", () => {
		expect(matchPaidMarketCell(cells, null, "organization", true)).toBeUndefined();
		expect(matchPaidMarketCell(cells, "BGR", "organization", true)).toBeUndefined();
		expect(matchPaidMarketCell(cells, "BG", null, true)).toBeUndefined();
	});
});

describe("the VAT-number status", () => {
	it("is required exactly for an organization in another member state", () => {
		for (const country of OTHER_MEMBER_STATES) {
			expect(vatIdStatusRequired(country, "organization")).toBe(true);
			expect(vatIdStatusRequired(country.toLowerCase(), "organization")).toBe(true);
			expect(vatIdStatusRequired(country, "consumer")).toBe(false);
		}
		for (const country of ["BG", "US", "CA", "GB", null, "", "DEU"]) {
			expect(vatIdStatusRequired(country, "organization")).toBe(false);
		}
		expect(vatIdStatusRequired("DE", null)).toBe(false);
	});

	it("converts between the stored status and the gate's boolean, keeping unknown unknown", () => {
		for (const status of VAT_ID_STATUSES) {
			expect(vatIdStatusOf(vatIdGivenOf(status))).toBe(status);
		}
		expect(vatIdGivenOf("given")).toBe(true);
		expect(vatIdGivenOf("not_given")).toBe(false);
		expect(vatIdGivenOf(null)).toBeNull();
		expect(vatIdGivenOf(undefined)).toBeNull();
		expect(vatIdStatusOf(null)).toBeNull();
		expect(vatIdStatusOf(undefined)).toBeNull();
	});
});

describe("the complimentary Early Access grant", () => {
	it("is offered exactly to a VAT-number business in another member state while unregistered", () => {
		for (const country of OTHER_MEMBER_STATES) {
			expect(complimentaryGrantEligible(country, "organization", true, false)).toBe(true);
			expect(complimentaryGrantEligible(country, "organization", false, false)).toBe(false);
			expect(complimentaryGrantEligible(country, "organization", null, false)).toBe(false);
			expect(complimentaryGrantEligible(country, "consumer", true, false)).toBe(false);
			// Once registered, that buyer is an ordinary sale.
			expect(complimentaryGrantEligible(country, "organization", true, true)).toBe(false);
		}
		for (const country of ["BG", "US", "CA", "GB", null]) {
			expect(complimentaryGrantEligible(country, "organization", true, false)).toBe(false);
		}
	});
});

describe("statutory withdrawal accounting (CRD art. 14(3))", () => {
	const base = {
		paidMinorUnits: 12_000,
		periodDays: 30,
		daysSupplied: 10,
		performanceStart: "immediate" as const,
		acknowledgedProportionalCharge: true,
	};

	// Nothing was supplied, so nothing may be kept. A "processing fee" here is simply unlawful.
	it("refunds everything when performance was deferred, even if days elapsed", () => {
		const out = withdrawalOutcome({
			...base,
			performanceStart: "deferred",
			daysSupplied: 29,
		});
		expect(out.refundMinorUnits).toBe(12_000);
		expect(out.retainedMinorUnits).toBe(0);
	});

	// THE sanction, and the reason the purchase flow must capture BOTH halves. Service really was
	// supplied here — and the trader may still keep nothing, because the acknowledgement was never
	// obtained. Getting this wrong is a silent overcharge of every withdrawing consumer.
	it("refunds everything when immediate performance was never acknowledged", () => {
		const out = withdrawalOutcome({
			...base,
			acknowledgedProportionalCharge: false,
		});
		expect(out.retainedMinorUnits).toBe(0);
		expect(out.refundMinorUnits).toBe(12_000);
		expect(out.basis).toMatch(/not acknowledged/i);
	});

	it("retains the supplied proportion when immediate performance was requested and acknowledged", () => {
		const out = withdrawalOutcome(base);
		expect(out.retainedMinorUnits).toBe(4_000); // 10/30 of 12000
		expect(out.refundMinorUnits).toBe(8_000);
	});

	// Rounding is a policy decision, and it goes to the consumer.
	it("floors the retained amount, so a fractional minor unit becomes refund", () => {
		const out = withdrawalOutcome({ ...base, paidMinorUnits: 1_000, periodDays: 30, daysSupplied: 1 });
		expect(out.retainedMinorUnits).toBe(33); // 33.33… floored
		expect(out.refundMinorUnits).toBe(967);
	});

	// The two halves must always reconcile — a split that loses or invents a minor unit would show up
	// as an unexplained difference between what Stripe refunded and what the record says.
	it("always splits the exact amount paid", () => {
		for (const days of [0, 1, 7, 15, 29, 30, 31, 400]) {
			for (const paid of [0, 1, 99, 12_000, 999_999]) {
				const out = withdrawalOutcome({ ...base, paidMinorUnits: paid, daysSupplied: days });
				expect(out.retainedMinorUnits + out.refundMinorUnits).toBe(paid);
				expect(out.retainedMinorUnits).toBeGreaterThanOrEqual(0);
				expect(out.refundMinorUnits).toBeGreaterThanOrEqual(0);
			}
		}
	});

	it("never retains more than the price when more days are supplied than the period holds", () => {
		const out = withdrawalOutcome({ ...base, daysSupplied: 900 });
		expect(out.retainedMinorUnits).toBe(12_000);
		expect(out.refundMinorUnits).toBe(0);
	});

	it("refunds everything rather than dividing by zero on a period with no length", () => {
		const out = withdrawalOutcome({ ...base, periodDays: 0 });
		expect(out.refundMinorUnits).toBe(12_000);
	});

	it("treats a negative amount or negative days as zero rather than inverting the split", () => {
		expect(withdrawalOutcome({ ...base, paidMinorUnits: -500 }).refundMinorUnits).toBe(0);
		expect(withdrawalOutcome({ ...base, daysSupplied: -5 }).retainedMinorUnits).toBe(0);
	});

	// The Bulgarian acknowledgement quotes `basis` (#7351). The locale changes the words and nothing
	// else: the same input must give the same split in every language.
	it("renders the basis in Bulgarian without changing the figures", () => {
		const inputs = [
			{ ...base, performanceStart: "deferred" as const },
			{ ...base, acknowledgedProportionalCharge: false },
			{ ...base, periodDays: 0 },
			base,
		];
		for (const input of inputs) {
			const en = withdrawalOutcome(input);
			const bg = withdrawalOutcome(input, "bg-BG");
			expect(bg.refundMinorUnits).toBe(en.refundMinorUnits);
			expect(bg.retainedMinorUnits).toBe(en.retainedMinorUnits);
			expect(bg.basis).not.toBe(en.basis);
			expect(bg.basis).toMatch(/[А-Яа-я]/);
		}
		expect(withdrawalOutcome(base, "bg-BG").basis).toBe(WITHDRAWAL_BASIS["bg-BG"].proportional(10, 30));
		expect(withdrawalOutcome(base, "bg-BG").basis).toContain("10 от 30 дни");
	});

	it("keeps the English basis as the default", () => {
		expect(withdrawalOutcome(base).basis).toBe(withdrawalOutcome(base, "en").basis);
		expect(withdrawalOutcome({ ...base, performanceStart: "deferred" }).basis).toBe(
			WITHDRAWAL_BASIS.en.deferred,
		);
	});
});

describe("the consumer's locale", () => {
	it("is Bulgarian for a Bulgarian billing country, in any case", () => {
		expect(consumerLocaleFor("BG")).toBe("bg-BG");
		expect(consumerLocaleFor(" bg ")).toBe("bg-BG");
	});

	it("is English for every other country, and for a missing one", () => {
		expect(consumerLocaleFor("DE")).toBe("en");
		expect(consumerLocaleFor("US")).toBe("en");
		expect(consumerLocaleFor(null)).toBe("en");
		expect(consumerLocaleFor("")).toBe("en");
	});
});

describe("contract formation", () => {
	// CRD art. 8(2): a vaguer label does not bind the consumer at all. Pinned so a copy edit that
	// softens it is a failing test rather than an unenforceable order.
	it("labels a consumer order with an unambiguous payment obligation", () => {
		expect(orderButtonLabel("consumer")).toBe(CONSUMER_PAYMENT_OBLIGATION_LABEL);
		expect(CONSUMER_PAYMENT_OBLIGATION_LABEL.toLowerCase()).toContain("obligation to pay");
	});

	it("does not put the consumer formulation on an organization order", () => {
		expect(orderButtonLabel("organization")).not.toBe(CONSUMER_PAYMENT_OBLIGATION_LABEL);
		expect(orderButtonLabel("organization").length).toBeGreaterThan(0);
	});

	// ЗЗП art. 49(2) names „поръчка със задължение за плащане“.
	it("labels a Bulgarian consumer order with the ЗЗП formulation", () => {
		expect(orderButtonLabel("consumer", "bg-BG")).toBe(CONSUMER_PAYMENT_OBLIGATION_LABEL_BG);
		expect(CONSUMER_PAYMENT_OBLIGATION_LABEL_BG.toLowerCase()).toContain("задължение за плащане");
		expect(orderButtonLabel("organization", "bg-BG")).not.toBe(CONSUMER_PAYMENT_OBLIGATION_LABEL_BG);
		expect(orderButtonLabel("consumer", "en")).toBe(CONSUMER_PAYMENT_OBLIGATION_LABEL);
	});
});

describe("consumer dispute resolution", () => {
	it("names a reachable body for every entry", () => {
		expect(CONSUMER_ADR.length).toBeGreaterThan(0);
		for (const body of CONSUMER_ADR) {
			expect(body.url).toMatch(/^https:\/\//);
			expect(body.name.length).toBeGreaterThan(0);
			expect(body.localName.length).toBeGreaterThan(0);
			expect(body.role.length).toBeGreaterThan(0);
			expect(body.localRole).toMatch(/[А-Яа-я]/);
		}
	});

	// Regulation (EU) 524/2013 was repealed and the ODR platform ceased on 20 July 2025. Linking it
	// points consumers at a dead service AND states an obligation that no longer exists — and it is
	// still what most templates say, which is exactly why this is a test and not a comment.
	it("does not link the repealed EU ODR platform", () => {
		for (const body of CONSUMER_ADR) {
			expect(body.url).not.toMatch(/ec\.europa\.eu\/consumers\/odr/i);
			expect(body.url).not.toMatch(/\bodr\b/i);
		}
	});
});
