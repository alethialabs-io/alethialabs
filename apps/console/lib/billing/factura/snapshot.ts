// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Builds the Art. 114 snapshot of a фактура (FacturaSnapshot, types/jsonb.types.ts) from Stripe's
// paid invoice (#7368). Pure: the number, the dates and the EUR rate are passed in, so the same
// inputs always give the same snapshot, and the PDF rendered from it is reproducible.
//
// What each field is, and where it comes from:
//  - supplier: the company (`LEGAL_ENTITY`), with its ЕИК as the Art. 84 ДОПК number while it is not
//    VAT-registered (TAX_MARKET_PRECONDITIONS.md §2.4);
//  - recipient: the Stripe invoice's customer name, address and tax ids, as `checks.ts` required;
//  - lines: the Stripe invoice lines. When they do not add up to the taxable amount (a discount, a
//    credit), one line carries the difference, so the document always adds up;
//  - amounts: the taxable amount is Stripe's total before tax; VAT is 0 (Art. 113(9));
//  - eurEquivalent: only for a non-EUR invoice, at the ECB reference rate for the chargeable date
//    (Art. 114(5); the 2026-11-23 ruling), recorded with the rate and its date.

import { LEGAL_ENTITY } from "@repo/legal/entity";
import { type EurRate, toEurMinor } from "@/lib/billing/ecb-rate";
import type { FacturaLine, FacturaParty, FacturaSnapshot } from "@/types/jsonb.types";
import type { FacturaSource, FacturaSourceLine } from "./checks";

/** The document name of a фактура (Art. 114(1), point 1). */
const FACTURA_DOCUMENT_NAME = "ФАКТУРА";

/** What the snapshot needs beyond the Stripe invoice. */
export interface SnapshotInputs {
	/** The ten-digit number taken from the series. */
	number: string;
	/** YYYY-MM-DD. */
	issueDate: string;
	/** YYYY-MM-DD: the date of the chargeable event (the payment). */
	chargeableDate: string;
	/** The ground for charging no VAT. */
	noVatGround: string;
	/** The rate for a non-EUR invoice; ignored for EUR. */
	eurRate: EurRate | null;
}

/**
 * The supplier block: the company as registered. The registered address reads "town, district,
 * street…, country"; it is printed street first, then town and district. The country is printed
 * from `country`, as for the recipient.
 */
function supplierParty(): FacturaParty {
	const parts = LEGAL_ENTITY.registeredAddressBulgarian.split(", ");
	return {
		name: `${LEGAL_ENTITY.legalNameBulgarian} ЕДПК`,
		addressLines: [parts.slice(2, -1).join(", "), parts.slice(0, 2).join(", ")],
		country: "BG",
		identifiers: [{ label: "ЕИК / Company ID", value: LEGAL_ENTITY.registrationNumber }],
	};
}

/** The recipient block from the Stripe invoice's customer details. */
function recipientParty(inv: FacturaSource): FacturaParty {
	const a = inv.customer_address;
	const town = [a?.postal_code, a?.city].filter(Boolean).join(" ");
	const addressLines = [a?.line1, a?.line2, town, a?.state].filter(
		(v): v is string => typeof v === "string" && v.trim() !== "",
	);
	return {
		name: inv.customer_name?.trim() ?? "",
		addressLines,
		country: (a?.country ?? "").toUpperCase(),
		identifiers: (inv.customer_tax_ids ?? [])
			.filter((t) => Boolean(t.value?.trim()))
			.map((t) => ({ label: t.type === "eu_vat" ? "ДДС № / VAT No." : "Идент. № / ID No.", value: t.value ?? "" })),
	};
}

/** epoch seconds → YYYY-MM-DD (UTC), or null. */
function isoDay(epochSeconds: number | null | undefined): string | null {
	return epochSeconds ? new Date(epochSeconds * 1000).toISOString().slice(0, 10) : null;
}

/** One фактура line from one Stripe line. */
function line(src: FacturaSourceLine): FacturaLine {
	const quantity = src.quantity && src.quantity > 0 ? src.quantity : 1;
	return {
		description: src.description?.trim() || "Услуга / Service",
		quantity,
		unitAmountMinor: Math.round(src.amount / quantity),
		amountMinor: src.amount,
		periodStart: isoDay(src.period?.start),
		periodEnd: isoDay(src.period?.end),
	};
}

/** The publication date in a rate source such as `ECB:2027-01-14`; the chargeable date otherwise. */
function rateDate(rate: EurRate, fallback: string): string {
	return /^[A-Z]+:(\d{4}-\d{2}-\d{2})$/.exec(rate.source)?.[1] ?? fallback;
}

/**
 * The snapshot of the фактура for a paid Stripe invoice. The caller has run the checks in
 * `checks.ts`, and passes a rate whenever the currency is not EUR.
 */
export function buildFacturaSnapshot(inv: FacturaSource, input: SnapshotInputs): FacturaSnapshot {
	const currency = inv.currency.toUpperCase();
	const taxBaseMinor = inv.total_excluding_tax ?? inv.total;
	const lines = (inv.lines?.data ?? []).map(line);
	const linesTotal = lines.reduce((sum, l) => sum + l.amountMinor, 0);
	if (linesTotal !== taxBaseMinor) {
		const diff = taxBaseMinor - linesTotal;
		lines.push({
			description: "Отстъпка или кредит / Discount or credit",
			quantity: 1,
			unitAmountMinor: diff,
			amountMinor: diff,
			periodStart: null,
			periodEnd: null,
		});
	}
	const eurRate = currency === "EUR" ? null : input.eurRate;
	return {
		version: 1,
		documentName: FACTURA_DOCUMENT_NAME,
		number: input.number,
		issueDate: input.issueDate,
		chargeableDate: input.chargeableDate,
		supplier: supplierParty(),
		recipient: recipientParty(inv),
		lines,
		currency,
		taxBaseMinor,
		vatMinor: 0,
		totalMinor: taxBaseMinor,
		noVatGround: input.noVatGround,
		eurEquivalent: eurRate
			? {
					taxBaseEurMinor: toEurMinor(taxBaseMinor, currency, eurRate),
					vatEurMinor: 0,
					rate: eurRate.eurPerUnit,
					rateDate: rateDate(eurRate, input.chargeableDate),
					source: eurRate.source,
				}
			: null,
		original: null,
		stripeInvoiceNumber: inv.number ?? null,
	};
}
