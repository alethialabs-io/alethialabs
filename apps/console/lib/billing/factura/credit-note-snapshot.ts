// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The snapshot of a credit note (кредитно известие, Art. 115 ЗДДС), as a pure function (#7369).
// It lives apart from the issuer (credit-note.ts) so that code with no server around it — the
// accountant export's `--demo` fixtures (lib/billing/nra/demo.ts, #7457), run under plain tsx — can
// build a credit note exactly as the issuer does without importing the database, storage and alert
// modules the issuer needs. What is printed and why is described in credit-note.ts.

import type { FacturaLine, FacturaSnapshot } from "@/types/jsonb.types";
import { vatAmountMinor } from "./vat-treatment";

/** The document name of a credit note (Art. 115 ЗДДС). */
export const CREDIT_NOTE_DOCUMENT_NAME = "КРЕДИТНО ИЗВЕСТИЕ";

/** What the snapshot of a credit note needs beyond the original and the refund. */
export interface CreditNoteInputs {
	/** The ten-digit number taken from the series. */
	number: string;
	/** YYYY-MM-DD. */
	issueDate: string;
	/** YYYY-MM-DD: the day of the refund (for a manual credit note: of the change to the tax base). */
	chargeableDate: string;
	/**
	 * The reason printed (Art. 115(3)). A Stripe credit note leaves it out and prints the refund
	 * reason; a manual one (manual.ts) passes the operator's.
	 */
	reason?: string;
}

/** A line with its amounts negated, for a full refund. */
function negated(l: FacturaLine): FacturaLine {
	return { ...l, unitAmountMinor: -l.unitAmountMinor, amountMinor: -l.amountMinor };
}

/** The EUR equivalent of `amountMinor` at a recorded rate, rounded half away from zero. */
function eurAt(amountMinor: number, rate: string): number {
	return Math.round(amountMinor * Number(rate));
}

/** `-n`, without the negative zero a strict equality in a test or a JSON round-trip would trip on. */
function negate(n: number): number {
	return n === 0 ? 0 : -n;
}

/** The single line of a partial credit note against `original`. */
function partialLine(original: FacturaSnapshot, creditMinor: number): FacturaLine {
	const description =
		original.source === "manual"
			? `Намаление на данъчната основа по фактура № ${original.number} / Reduction of the taxable amount of invoice No. ${original.number}`
			: `Възстановена сума по фактура № ${original.number} / Refund against invoice No. ${original.number}`;
	return {
		description,
		quantity: 1,
		unitAmountMinor: -creditMinor,
		amountMinor: -creditMinor,
		periodStart: null,
		periodEnd: null,
	};
}

/**
 * The snapshot of the credit note reducing the TAXABLE AMOUNT of the фактура `original` by
 * `creditMinor`. Pure: the same inputs always give the same snapshot, so its PDF is reproducible.
 *
 * VAT follows the original: a full credit negates its VAT exactly, a partial one charges the
 * original's rate on the credited amount. A Stripe фактура carries no VAT (Art. 113(9)), so for it
 * the taxable amount IS the refunded total and nothing below changes what a Stripe credit note was.
 * The VAT treatment, rate and reference are carried over from the original when it has them.
 */
export function buildCreditNoteSnapshot(
	original: FacturaSnapshot,
	creditMinor: number,
	input: CreditNoteInputs,
): FacturaSnapshot {
	const full = creditMinor === original.taxBaseMinor;
	const rate = original.vatRatePercent ?? 0;
	const vatMinor = full ? original.vatMinor : vatAmountMinor(creditMinor, rate);
	const lines: FacturaLine[] = full ? original.lines.map(negated) : [partialLine(original, creditMinor)];
	const eur = original.eurEquivalent;
	return {
		version: 1,
		documentName: CREDIT_NOTE_DOCUMENT_NAME,
		number: input.number,
		issueDate: input.issueDate,
		chargeableDate: input.chargeableDate,
		supplier: original.supplier,
		recipient: original.recipient,
		lines,
		currency: original.currency,
		taxBaseMinor: -creditMinor,
		vatMinor: negate(vatMinor),
		totalMinor: -(creditMinor + vatMinor),
		noVatGround: original.noVatGround,
		eurEquivalent: eur
			? {
					taxBaseEurMinor: full ? -eur.taxBaseEurMinor : -eurAt(creditMinor, eur.rate),
					vatEurMinor: negate(full ? eur.vatEurMinor : eurAt(vatMinor, eur.rate)),
					rate: eur.rate,
					rateDate: eur.rateDate,
					source: eur.source,
				}
			: null,
		original: { number: original.number, issueDate: original.issueDate },
		reason:
			input.reason ??
			(full
				? "Пълно възстановяване на плащането / Full refund of the payment"
				: "Частично възстановяване на плащането / Partial refund of the payment"),
		stripeInvoiceNumber: original.stripeInvoiceNumber,
		...(original.source ? { source: original.source } : {}),
		...(original.vatTreatment ? { vatTreatment: original.vatTreatment } : {}),
		...(original.vatRatePercent ? { vatRatePercent: original.vatRatePercent } : {}),
		...(original.reference ? { reference: original.reference } : {}),
	};
}
